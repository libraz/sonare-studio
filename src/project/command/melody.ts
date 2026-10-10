import { tidyGridPpq, tidyNotes } from '@/compose/tidy-notes';
import { OperationGeneration } from '@/lib/operation-generation';
import { ensureWasm } from '@/lib/wasm';
import { loadAsset, loadAssetMeta } from '@/persistence/assets';
import {
  type AudioMelodyAnalyzer,
  type AudioMelodyDeps,
  analyzeAudioClipMelody,
} from '../audio-melody';
import { type AudioTranscriptionOptions, transcribeAudioClip } from '../audio-transcription';
import {
  assertProjectOperationCurrent,
  beginProjectOperation,
  StaleProjectOperationError,
} from '../operation';
import { getProject, notesToProjectEvents, useProjectStore } from '../store';
import { meterBarLengthPpq, timeSignatureAt } from '../time-signature';
import { transcribeAudioInWorker } from '../transcribe-client';
import { clipKind, TRACK_COLOR_PALETTE } from '../types';
import { executeAtomic } from './history';
import { requireClip } from './utils';

const melodyAnalysisOperations = new OperationGeneration();
const transcriptionOperations = new OperationGeneration();

/** Options for the canonical mono/polyphonic audio-to-MIDI command. */
export interface TranscribeAudioClipToMidiOptions {
  /** `true` enables overlapping multi-F0 transcription. */
  polyphonic?: boolean;
  /** Cancels worker analysis before the project mutation is reached. */
  signal?: AbortSignal;
  /** Tuning reference in Hz, or `'auto'` to measure it; omitted means 440 Hz. */
  referenceHz?: number | 'auto';
  /** Shortest note kept, as a `1/n` note at the clip's tempo; omitted keeps the library default. */
  minNoteDivision?: number;
  /** `true` re-times the result by harmony, meter and phrase before it is written. */
  tidy?: boolean;
  /** Receives the tuning the notes were measured against, in fractions of a semitone. */
  onTuning?: (tuning: number) => void;
  /** Injectable adapter for command tests and host integrations. */
  transcribe?: typeof transcribeAudioClip;
}

/** Creates a signal that follows both project staleness and user cancellation. */
function linkedAbortSignal(
  first: AbortSignal,
  second: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void } {
  if (second === undefined) return { signal: first, dispose: () => undefined };
  const controller = new AbortController();
  const abort = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  if (first.aborted) abort(first);
  if (second.aborted) abort(second);
  const onFirstAbort = (): void => abort(first);
  const onSecondAbort = (): void => abort(second);
  first.addEventListener('abort', onFirstAbort, { once: true });
  second.addEventListener('abort', onSecondAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      first.removeEventListener('abort', onFirstAbort);
      second.removeEventListener('abort', onSecondAbort);
    },
  };
}

function throwIfSignalAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  if (typeof DOMException !== 'undefined') {
    throw new DOMException('Transcription was aborted', 'AbortError');
  }
  const error = new Error('Transcription was aborted');
  error.name = 'AbortError';
  throw error;
}

function melodySourceRevision(
  store: ReturnType<typeof useProjectStore>,
  clipId: number,
): string | null {
  const clip = store.clips.find((entry) => entry.id === clipId);
  if (!clip || clipKind(clip) !== 'audio') return null;
  return JSON.stringify({
    clip: {
      id: clip.id,
      trackId: clip.trackId,
      name: clip.name,
      assetId: clip.assetId,
      startPpq: clip.startPpq,
      lengthPpq: clip.lengthPpq,
      sourceOffsetPpq: clip.sourceOffsetPpq,
      loopEnabled: clip.loopEnabled,
      loopLengthPpq: clip.loopLengthPpq,
      fadeInPpq: clip.fadeInPpq,
      fadeOutPpq: clip.fadeOutPpq,
      takes: clip.takes,
      compSegments: clip.compSegments,
      warp: clip.warp,
    },
    tempoBpm: store.tempoBpm,
    tempoSegments: store.tempoSegments,
    snapEnabled: store.snapEnabled,
    snapDivision: store.snapDivision,
    snapBar: store.snapBar,
    timeSignatures: store.timeSignatures,
  });
}

/**
 * Extracts a monophonic melody from an audio clip and lays it down as a new
 * MIDI clip on a new MIDI track, as one undoable edit.
 *
 * The clip's source window is analyzed with libsonare's `analyzeMelody`
 * (delegated; see {@link analyzeAudioClipMelody}) and the contour is segmented
 * into notes. The new MIDI clip mirrors the audio clip's timeline position and
 * length, so the transcription lines up under the source audio.
 *
 * The track, clip and its notes are three wasm-Project edits committed inside a
 * single `execute`, so undo reverts the whole transcription at once.
 *
 * @param clipId Id of the audio clip to transcribe.
 * @returns The new MIDI clip id, or -1 when `analyzeMelody` is unavailable or
 *   no notes were detected (nothing is created in either case).
 * @throws RangeError when the clip is not an audio clip.
 */
export async function extractMelodyFromAudioClip(clipId: number): Promise<number> {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if (clipKind(clip) !== 'audio') {
    throw new RangeError(`Clip ${clipId} is not an audio clip`);
  }
  const targetId = `melody:${clipId}`;
  const operation = beginProjectOperation(
    melodyAnalysisOperations,
    store,
    targetId,
    melodySourceRevision(store, clipId),
  );
  const assertCurrent = (): void =>
    assertProjectOperationCurrent(
      melodyAnalysisOperations,
      operation,
      store,
      targetId,
      melodySourceRevision(store, clipId),
    );
  try {
    const wasm = (await ensureWasm()) as unknown as {
      analyzeMelody?: AudioMelodyAnalyzer;
      detectKey?: AudioMelodyDeps['detectKey'];
      scaleQuantizeMidi?: AudioMelodyDeps['scaleQuantizeMidi'];
    };
    assertCurrent();
    if (typeof wasm.analyzeMelody !== 'function') return -1;
    const rhythmQuantizePpq = store.snapEnabled
      ? store.snapBar
        ? meterBarLengthPpq(timeSignatureAt(store.timeSignatures, clip.startPpq))
        : 4 / store.snapDivision
      : undefined;
    const notes = await analyzeAudioClipMelody(
      clip,
      store.tempoBpm,
      {
        loadAudioAsset: loadAsset,
        analyzeMelody: wasm.analyzeMelody,
        detectKey: wasm.detectKey,
        scaleQuantizeMidi: wasm.scaleQuantizeMidi,
      },
      { rhythmQuantizePpq },
      store.tempoSegments,
    );
    assertCurrent();
    if (notes.length === 0) return -1;

    const project = getProject();
    const trackName = `${clip.name} melody`;
    const color = TRACK_COLOR_PALETTE[store.tracks.length % TRACK_COLOR_PALETTE.length];
    const startPpq = clip.startPpq;
    const lengthPpq = clip.lengthPpq;
    const events = notesToProjectEvents(notes.map((note) => ({ ...note, channel: 0 })));

    // addTrack (1) + addClip/midi (1) + setMidiEvents (1) = 3 Project history edits.
    return executeAtomic((edit) => {
      const trackId = edit(1, () => project.addTrack({ kind: 'midi', name: trackName }));
      store.tracks = [
        ...store.tracks,
        {
          id: trackId,
          name: trackName,
          color,
          kind: 'midi',
          mute: false,
          solo: false,
          volume: 1,
          pan: 0,
          order: store.tracks.length,
        },
      ];
      const newClipId = edit(1, () =>
        project.addClip({ trackId, isMidi: true, startPpq, lengthPpq }),
      );
      store.clips = [
        ...store.clips,
        {
          id: newClipId,
          trackId,
          name: trackName,
          startPpq,
          lengthPpq,
          sourceOffsetPpq: 0,
          gain: 1,
          loopEnabled: false,
          loopLengthPpq: 0,
          notes: [],
        },
      ];
      edit(1, () => project.setMidiEvents(newClipId, events));
      store.refresh();
      return newClipId;
    });
  } catch (error) {
    if (error instanceof StaleProjectOperationError) return -1;
    throw error;
  } finally {
    if (melodyAnalysisOperations.isCurrent(operation.token)) {
      melodyAnalysisOperations.invalidate();
    }
  }
}

/**
 * Transcribes an audio clip with libsonare's canonical mono/polyphonic
 * detector and lays the result down as one new MIDI track and clip.
 *
 * Every asynchronous step completes before the three native Project edits are
 * entered into one atomic history entry. The operation identity is checked
 * immediately before that entry, so replacing the project or editing the
 * source clip while the worker runs cannot create stale MIDI content.
 *
 * @returns The new MIDI clip id, or -1 when no notes were detected or the
 *   operation became stale.
 */
export async function transcribeAudioClipToMidi(
  clipId: number,
  options: TranscribeAudioClipToMidiOptions = {},
): Promise<number> {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if (clipKind(clip) !== 'audio') {
    throw new RangeError(`Clip ${clipId} is not an audio clip`);
  }
  const targetId = `transcription:${clipId}`;
  const operation = beginProjectOperation(
    transcriptionOperations,
    store,
    targetId,
    melodySourceRevision(store, clipId),
  );
  const assertCurrent = (): void =>
    assertProjectOperationCurrent(
      transcriptionOperations,
      operation,
      store,
      targetId,
      melodySourceRevision(store, clipId),
    );
  const linked = linkedAbortSignal(operation.token.signal, options.signal);
  try {
    const rhythmQuantizePpq = store.snapEnabled
      ? store.snapBar
        ? meterBarLengthPpq(timeSignatureAt(store.timeSignatures, clip.startPpq))
        : 4 / store.snapDivision
      : undefined;
    const transcriptionOptions: AudioTranscriptionOptions = {
      polyphonic: options.polyphonic === true,
      signal: linked.signal,
      rhythmQuantizePpq,
      referenceHz: options.referenceHz,
      minNoteDivision: options.minNoteDivision,
      onTuning: options.onTuning,
    };
    const notes = await (options.transcribe ?? transcribeAudioClip)(
      clip,
      store.tempoBpm,
      {
        loadAudioAsset: async (assetId) => {
          const asset = await loadAsset(assetId);
          assertCurrent();
          return asset;
        },
        loadAudioAssetMeta: async (assetId) => {
          const meta = await loadAssetMeta(assetId);
          assertCurrent();
          return meta;
        },
        transcribe: transcribeAudioInWorker,
      },
      transcriptionOptions,
      store.tempoSegments,
    );
    throwIfSignalAborted(linked.signal);
    assertCurrent();
    if (notes.length === 0) return -1;

    const project = getProject();
    const trackName = `${clip.name} ${options.polyphonic === true ? 'polyphonic' : 'melody'}`;
    const color = TRACK_COLOR_PALETTE[store.tracks.length % TRACK_COLOR_PALETTE.length];
    const startPpq = clip.startPpq;
    const lengthPpq = clip.lengthPpq;
    const events = notesToProjectEvents(
      options.tidy === true
        ? tidyNotes(
            notes.map((note) => ({ ...note, startPpq: note.startPpq + startPpq })),
            {
              gridPpq: tidyGridPpq(store),
              timeSignatures: store.timeSignatures,
              chords: store.chords,
              endPpq: startPpq + lengthPpq,
            },
          ).map((note) => ({ ...note, startPpq: note.startPpq - startPpq }))
        : notes,
    );

    // addTrack (1) + addClip/midi (1) + setMidiEvents (1) = 3 Project edits.
    return executeAtomic((edit) => {
      const trackId = edit(1, () => project.addTrack({ kind: 'midi', name: trackName }));
      store.tracks = [
        ...store.tracks,
        {
          id: trackId,
          name: trackName,
          color,
          kind: 'midi',
          mute: false,
          solo: false,
          volume: 1,
          pan: 0,
          order: store.tracks.length,
        },
      ];
      const newClipId = edit(1, () =>
        project.addClip({ trackId, isMidi: true, startPpq, lengthPpq }),
      );
      store.clips = [
        ...store.clips,
        {
          id: newClipId,
          trackId,
          name: trackName,
          startPpq,
          lengthPpq,
          sourceOffsetPpq: 0,
          gain: 1,
          loopEnabled: false,
          loopLengthPpq: 0,
          notes: [],
        },
      ];
      edit(1, () => project.setMidiEvents(newClipId, events));
      store.refresh();
      return newClipId;
    });
  } catch (error) {
    if (error instanceof StaleProjectOperationError) return -1;
    // A superseded project operation is a silent stale result. User aborts
    // remain errors so the dialog can clear its busy state without surfacing
    // a misleading analysis failure.
    if (operation.token.signal.aborted && !options.signal?.aborted) return -1;
    throw error;
  } finally {
    linked.dispose();
    if (transcriptionOperations.isCurrent(operation.token)) {
      transcriptionOperations.invalidate();
    }
  }
}
