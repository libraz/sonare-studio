import { tidyGridPpq, tidyNotes } from '@/compose/tidy-notes';
import { peakDb } from '@/lib/db';
import { OperationGeneration } from '@/lib/operation-generation';
import { ensureWasm } from '@/lib/wasm';
import { loadAsset, loadAssetMeta } from '@/persistence/assets';
import { type DetectedBeats, detectBeatsInWorker } from '../audio-analysis-client';
import {
  type AudioMelodyAnalyzer,
  type AudioMelodyDeps,
  analyzeAudioClipMelody,
} from '../audio-melody';
import { detectAudioClipBeatGrid, quarterBeatsPerBar } from '../audio-tempo';
import {
  type AudioTranscriptionOptions,
  quantizeNotes,
  transcribeAudioClip,
} from '../audio-transcription';
import { type BeatGrid, gridTempoSegments, onsetPhaseOffsetBeats } from '../beat-grid';
import {
  assertProjectOperationCurrent,
  beginProjectOperation,
  StaleProjectOperationError,
} from '../operation';
import { getProject, notesToProjectEvents, useProjectStore } from '../store';
import { meterBarLengthPpq, snapPpqToMeterGrid, timeSignatureAt } from '../time-signature';
import { transcribeAudioInWorker } from '../transcribe-client';
import { clipKind, type TempoSegment, TRACK_COLOR_PALETTE } from '../types';
import { assertNoNewClipOverlaps } from './clips-editing';
import { executeAtomic } from './history';
import { applyTempoSegments, validateTempoSegments } from './timeline';
import { requireClip } from './utils';

const melodyAnalysisOperations = new OperationGeneration();
const transcriptionOperations = new OperationGeneration();

/** The detector drops everything under this input level, so an empty result under it means silence. */
const SILENT_INPUT_DB = -80;

/** Why a transcription created no clip. */
export type TranscribeClipRefusal = 'silent' | 'no-notes' | 'stale';

/** Outcome of transcribing an audio clip to a new MIDI clip. */
export type TranscribeClipOutcome =
  | { created: true; clipId: number }
  | { created: false; reason: TranscribeClipRefusal };

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
  /** Polyphonic only: most notes one frame may hold, `1..64`; omitted keeps the library default. */
  maxPolyphony?: number;
  /** `true` re-times the result by harmony, meter and phrase before it is written. */
  tidy?: boolean;
  /**
   * `true` sets the project tempo to the recording's and moves the clip so its
   * first downbeat sits on a bar line, in the same undoable edit. Ignored for a
   * warped clip, which already plays at the project tempo.
   */
  matchTempo?: boolean;
  /** Injectable beat tracker for command tests; defaults to the analysis worker. */
  detectBeats?: (mono: Float32Array, sampleRate: number) => Promise<DetectedBeats>;
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
 * @returns The new MIDI clip id, or why none was created.
 */
export async function transcribeAudioClipToMidi(
  clipId: number,
  options: TranscribeAudioClipToMidiOptions = {},
): Promise<TranscribeClipOutcome> {
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
    const loadAudioAsset = async (assetId: string) => {
      const asset = await loadAsset(assetId);
      assertCurrent();
      return asset;
    };

    // The recording's own grid, when the project tempo is to follow it. The
    // notes are read against it before anything in the project changes.
    const beatsPerBar = quarterBeatsPerBar(store.timeSignatures, clip.startPpq);
    let grid: BeatGrid | null = null;
    let tempoSegments: TempoSegment[] = store.tempoSegments.length
      ? store.tempoSegments
      : [{ startPpq: 0, bpm: store.tempoBpm }];
    let gridDownbeatPpq = 0;
    if (options.matchTempo === true && clip.warp?.enabled !== true) {
      const detectBeats =
        options.detectBeats ??
        ((mono: Float32Array, sampleRate: number) =>
          detectBeatsInWorker(mono, sampleRate, { signal: linked.signal }));
      grid = await detectAudioClipBeatGrid(clip, tempoSegments, beatsPerBar, {
        loadAudioAsset,
        detectBeats,
      });
      throwIfSignalAborted(linked.signal);
      assertCurrent();
      if (grid) {
        gridDownbeatPpq =
          clip.startPpq + (grid.downbeatSeconds * (grid.barBpms[0] ?? grid.bpm)) / 60;
        tempoSegments = gridTempoSegments(grid, gridDownbeatPpq, beatsPerBar);
      }
    }

    const transcriptionOptions: AudioTranscriptionOptions = {
      polyphonic: options.polyphonic === true,
      signal: linked.signal,
      // A matched grid is only known once the onsets are read, so it snaps below.
      rhythmQuantizePpq: grid ? undefined : rhythmQuantizePpq,
      referenceHz: options.referenceHz,
      minNoteDivision: options.minNoteDivision,
      maxPolyphony: options.maxPolyphony,
      onTuning: options.onTuning,
    };
    const transcription = await (options.transcribe ?? transcribeAudioClip)(
      clip,
      grid ? tempoSegments[0].bpm : store.tempoBpm,
      {
        loadAudioAsset,
        loadAudioAssetMeta: async (assetId) => {
          const meta = await loadAssetMeta(assetId);
          assertCurrent();
          return meta;
        },
        transcribe: transcribeAudioInWorker,
      },
      transcriptionOptions,
      grid ? tempoSegments : store.tempoSegments,
    );
    throwIfSignalAborted(linked.signal);
    assertCurrent();
    let notes = transcription.notes;
    if (notes.length === 0) {
      const silent = peakDb(transcription.peak) < SILENT_INPUT_DB;
      return { created: false, reason: silent ? 'silent' : 'no-notes' };
    }

    let startPpq = clip.startPpq;
    if (grid) {
      // The detector's onsets sit a constant fraction of a beat off the
      // tracked beats; the music's downbeat is where the onsets put it.
      const relativeDownbeat = gridDownbeatPpq - clip.startPpq;
      const musicalDownbeat =
        relativeDownbeat +
        onsetPhaseOffsetBeats(
          notes.map((note) => note.startPpq - relativeDownbeat),
          notes.map((note) => note.velocity),
        );
      const absoluteDownbeat = clip.startPpq + musicalDownbeat;
      let barLine = snapPpqToMeterGrid(store.timeSignatures, absoluteDownbeat, 'bar');
      if (barLine - musicalDownbeat < 0)
        barLine += meterBarLengthPpq(timeSignatureAt(store.timeSignatures, barLine));
      startPpq = barLine - musicalDownbeat;
      tempoSegments = gridTempoSegments(grid, barLine, beatsPerBar);
      validateTempoSegments(tempoSegments);
      notes = quantizeNotes(notes, rhythmQuantizePpq, clip.lengthPpq, musicalDownbeat);
      if (getProject().getOverlapPolicy() === 1) {
        assertNoNewClipOverlaps(store.clips, [
          { clipId, startPpq, lengthPpq: clip.lengthPpq, trackId: clip.trackId },
        ]);
      }
    }

    const project = getProject();
    const trackName = `${clip.name} ${options.polyphonic === true ? 'polyphonic' : 'melody'}`;
    const color = TRACK_COLOR_PALETTE[store.tracks.length % TRACK_COLOR_PALETTE.length];
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

    // [tempo + clip move when matched] + addTrack + addClip/midi + setMidiEvents.
    return executeAtomic((edit) => {
      if (grid) {
        applyTempoSegments(edit, tempoSegments);
        if (startPpq !== clip.startPpq) {
          edit(1, () => project.moveClip(clipId, startPpq));
          store.refresh();
        }
      }
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
      return { created: true, clipId: newClipId };
    });
  } catch (error) {
    if (error instanceof StaleProjectOperationError) return { created: false, reason: 'stale' };
    // A superseded project operation is a stale result. User aborts remain
    // errors so the dialog can clear its busy state without surfacing a
    // misleading analysis failure.
    if (operation.token.signal.aborted && !options.signal?.aborted) {
      return { created: false, reason: 'stale' };
    }
    throw error;
  } finally {
    linked.dispose();
    if (transcriptionOperations.isCurrent(operation.token)) {
      transcriptionOperations.invalidate();
    }
  }
}
