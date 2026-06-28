import { ensureWasm } from '@/lib/wasm';
import { loadAsset } from '@/persistence/assets';
import { type AudioMelodyAnalyzer, analyzeAudioClipMelody } from '../audio-melody';
import { getProject, notesToProjectEvents, useProjectStore } from '../store';
import { clipKind, TRACK_COLOR_PALETTE } from '../types';
import { execute } from './history';
import { requireClip } from './utils';

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
  const wasm = (await ensureWasm()) as unknown as { analyzeMelody?: AudioMelodyAnalyzer };
  if (typeof wasm.analyzeMelody !== 'function') return -1;
  const notes = await analyzeAudioClipMelody(
    clip,
    store.tempoBpm,
    {
      loadAudioAsset: loadAsset,
      analyzeMelody: wasm.analyzeMelody,
    },
    {},
    store.tempoSegments,
  );
  if (notes.length === 0) return -1;

  const project = getProject();
  const trackName = `${clip.name} melody`;
  const color = TRACK_COLOR_PALETTE[store.tracks.length % TRACK_COLOR_PALETTE.length];
  const startPpq = clip.startPpq;
  const lengthPpq = clip.lengthPpq;
  const events = notesToProjectEvents(notes.map((note) => ({ ...note, channel: 0 })));

  // addTrack (1) + addClip/midi (2) + setMidiEvents (1) = 4 Project history edits.
  return execute(4, () => {
    const trackId = project.addTrack({ kind: 'midi', name: trackName });
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
    const newClipId = project.addClip({ trackId, isMidi: true, startPpq, lengthPpq });
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
    project.setMidiEvents(newClipId, events);
    store.refresh();
    return newClipId;
  });
}
