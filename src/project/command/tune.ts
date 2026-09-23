import { ensureWasm } from '@/lib/wasm';
import { createAudioAssetTransaction } from '@/persistence/asset-transaction';
import { loadAsset } from '@/persistence/assets';
import type { NoteTargetUnmatchedPolicy } from '@/wasm/index.js';
import { collectReferencedAudioAssetIds } from '../asset-references';
import { tuneAudioClipToMidi } from '../audio-tune-to-midi';
import { getProject, useProjectStore } from '../store';
import { normalizeTempoMap } from '../tempo-map';
import { clipKind, type EditorClip } from '../types';
import { replaceAudioClipAsset } from './clips-asset';
import { requireClip, requireTrack } from './utils';

/** Outcome of tuning a clip to a MIDI track. */
export interface TuneToMidiOutcome {
  /** Id of the clip now playing the tuned audio. */
  clipId: number;
  /** Notes measured in the take. */
  noteCount: number;
  /** Notes that took a MIDI target; zero means the reference did not line up. */
  assignedCount: number;
}

/** Everything the tuning read, so a concurrent edit invalidates the result. */
function sourceToken(clip: EditorClip, midiClips: ReadonlyArray<EditorClip>): string {
  const store = useProjectStore();
  return JSON.stringify({
    clip,
    midiClips,
    tempoBpm: store.tempoBpm,
    tempoSegments: store.tempoSegments,
  });
}

/**
 * Tunes an audio clip's recording to the notes of a MIDI track and swaps the
 * tuned audio in as one undoable edit (see {@link tuneAudioClipToMidi}).
 *
 * @param clipId Audio clip to tune.
 * @param midiTrackId MIDI track whose notes are the reference melody.
 * @param policy What becomes of a take note the reference does not reach.
 * @returns The outcome, or null when the source changed while tuning.
 * @throws TuneToMidiRefusedError when the clip or reference rules it out.
 */
export async function tuneAudioClipToMidiTrack(
  clipId: number,
  midiTrackId: number,
  policy: NoteTargetUnmatchedPolicy,
): Promise<TuneToMidiOutcome | null> {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if (clipKind(clip) !== 'audio') throw new RangeError(`Clip ${clipId} is not an audio clip`);
  const midiTrack = requireTrack(store, midiTrackId);
  if (midiTrack.kind !== 'midi') throw new RangeError(`Track ${midiTrackId} is not a MIDI track`);
  const midiClips = store.clips.filter(
    (entry) => entry.trackId === midiTrackId && clipKind(entry) === 'midi',
  );
  const project = getProject();
  const token = sourceToken(clip, midiClips);
  const isCurrent = (): boolean => {
    const current = store.clips.find((entry) => entry.id === clipId);
    const currentMidi = store.clips.filter(
      (entry) => entry.trackId === midiTrackId && clipKind(entry) === 'midi',
    );
    return (
      getProject() === project &&
      current !== undefined &&
      sourceToken(current, currentMidi) === token
    );
  };

  const wasm = await ensureWasm();
  const tuned = await tuneAudioClipToMidi(
    clip,
    midiClips,
    normalizeTempoMap(store.tempoSegments, store.tempoBpm),
    policy,
    {
      loadAudioAsset: loadAsset,
      pitchPyin: (samples, sampleRate, frameLength, hopLength) =>
        wasm.pitchPyin(samples, sampleRate, frameLength, hopLength),
      extractNotes: (request) => wasm.extractNotes(request),
      assignNoteTargets: (request) => wasm.assignNoteTargets(request),
      renderNotes: (request) => wasm.renderNotes(request),
    },
  );
  if (!tuned || !isCurrent()) return null;

  const assets = createAudioAssetTransaction();
  const isReferenced = (assetId: string): boolean =>
    collectReferencedAudioAssetIds(store.clips, store.tracks).has(assetId);
  try {
    const meta = await assets.save(
      { name: `${clip.name} tuned`, sampleRate: tuned.sampleRate },
      tuned.channels,
    );
    if (!isCurrent()) {
      await assets.rollback(isReferenced);
      return null;
    }
    const newClipId = replaceAudioClipAsset(clipId, meta.id);
    assets.commit();
    return { clipId: newClipId, noteCount: tuned.noteCount, assignedCount: tuned.assignedCount };
  } catch (error) {
    await assets.rollback(isReferenced);
    throw error;
  }
}
