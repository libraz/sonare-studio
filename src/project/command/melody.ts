import { OperationGeneration } from '@/lib/operation-generation';
import { ensureWasm } from '@/lib/wasm';
import { loadAsset } from '@/persistence/assets';
import {
  type AudioMelodyAnalyzer,
  type AudioMelodyDeps,
  analyzeAudioClipMelody,
} from '../audio-melody';
import {
  assertProjectOperationCurrent,
  beginProjectOperation,
  StaleProjectOperationError,
} from '../operation';
import { getProject, notesToProjectEvents, useProjectStore } from '../store';
import { meterBarLengthPpq, timeSignatureAt } from '../time-signature';
import { clipKind, TRACK_COLOR_PALETTE } from '../types';
import { executeAtomic } from './history';
import { requireClip } from './utils';

const melodyAnalysisOperations = new OperationGeneration();

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
      takes: clip.takes,
      compSegments: clip.compSegments,
      warp: clip.warp,
    },
    tempoBpm: store.tempoBpm,
    tempoSegments: store.tempoSegments,
    snapEnabled: store.snapEnabled,
    snapDivision: store.snapDivision,
    snapBar: store.snapBar,
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

    // addTrack (1) + addClip/midi (2) + setMidiEvents (1) = 4 Project history edits.
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
      const newClipId = edit(2, () =>
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
