/**
 * Tunes an audio clip's recording to the notes of a MIDI track: the take's own
 * notes are measured, each is matched to the MIDI note it overlaps in time, and
 * the corrections are rendered into a new version of the clip's audio.
 *
 * The MIDI notes are placed in the asset's own seconds through the tempo map,
 * using the same origin playback slices the clip from (the asset starts at
 * `startPpq - sourceOffsetPpq`). That mapping holds only while the clip plays
 * its asset straight, so warped, looped and comped clips are refused. The pitch
 * is measured once on the mono downmix and the same note edits are rendered on
 * every channel, which keeps a stereo take's image intact. Side-effect-free and
 * dependency-injected; storing the result and rebinding the clip live in
 * command/tune.
 */

import { downmixToMono } from '@/lib/audio-channels';
import type { LoadedAudioAsset } from '@/persistence/assets';
import {
  NOTE_DETECT_FRAME,
  NOTE_DETECT_HOP,
  NOTE_DETECT_THRESHOLD_CENTS,
} from '@/ui/sample-editor/wasm-ops';
import type {
  AssignNoteTargetsRequest,
  ExtractNotesRequest,
  NoteObject,
  NoteTarget,
  NoteTargetAssignResult,
  NoteTargetUnmatchedPolicy,
  RenderNotesRequest,
} from '@/wasm/index.js';
import { projectMidiNoteOccurrences } from './midi-projection';
import { type NormalizedTempoMap, ppqToSeconds } from './tempo-map';
import type { EditorClip } from './types';

/** Why a clip cannot be tuned to a MIDI track. */
export type TuneToMidiRefusal = 'warped' | 'looped' | 'comped' | 'no-notes';

/** Thrown when the clip's shape or the reference rules the tuning out. */
export class TuneToMidiRefusedError extends Error {
  constructor(readonly reason: TuneToMidiRefusal) {
    super(`Cannot tune this clip to MIDI: ${reason}`);
    this.name = 'TuneToMidiRefusedError';
  }
}

/** Injectable dependencies for {@link tuneAudioClipToMidi}. */
export interface TuneToMidiDeps {
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>;
  pitchPyin: (
    samples: Float32Array,
    sampleRate: number,
    frameLength: number,
    hopLength: number,
  ) => { f0: Float32Array; voicedFlag: ArrayLike<boolean | number> };
  extractNotes: (request: ExtractNotesRequest) => NoteObject[];
  assignNoteTargets: (request: AssignNoteTargetsRequest) => NoteTargetAssignResult;
  renderNotes: (request: RenderNotesRequest) => Float32Array;
}

/** A tuned version of the clip's audio, with how much of the take was matched. */
export interface TunedAudio {
  channels: Float32Array[];
  sampleRate: number;
  /** Notes measured in the take. */
  noteCount: number;
  /** Notes that took a MIDI target. */
  assignedCount: number;
}

/**
 * Reference notes of MIDI clips, in seconds of an asset whose first frame sits
 * at `originPpq` on the timeline.
 */
export function midiNoteTargets(
  midiClips: ReadonlyArray<EditorClip>,
  tempo: NormalizedTempoMap,
  originPpq: number,
): NoteTarget[] {
  const originSec = ppqToSeconds(tempo, originPpq);
  const targets: NoteTarget[] = [];
  for (const clip of midiClips) {
    for (const note of projectMidiNoteOccurrences(clip)) {
      const startSec = ppqToSeconds(tempo, note.startPpq) - originSec;
      const endSec = ppqToSeconds(tempo, note.startPpq + note.durationPpq) - originSec;
      if (endSec <= 0) continue;
      targets.push({ startSec: Math.max(0, startSec), endSec, targetMidi: note.pitch });
    }
  }
  return targets.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Tunes an audio clip's recording to the notes of MIDI clips.
 *
 * @param clip The audio clip (needs an asset; must play it straight).
 * @param midiClips The reference track's MIDI clips.
 * @param tempo Project tempo map.
 * @param policy What becomes of a take note that no MIDI note overlaps.
 * @param deps Asset loader and the note-editing functions.
 * @throws TuneToMidiRefusedError when the clip is warped, looped or comped, or
 *   the reference has no notes over the recording.
 */
export async function tuneAudioClipToMidi(
  clip: EditorClip,
  midiClips: ReadonlyArray<EditorClip>,
  tempo: NormalizedTempoMap,
  policy: NoteTargetUnmatchedPolicy,
  deps: TuneToMidiDeps,
): Promise<TunedAudio | null> {
  if (clip.assetId === undefined) return null;
  if (clip.warp?.enabled) throw new TuneToMidiRefusedError('warped');
  if (clip.loopEnabled) throw new TuneToMidiRefusedError('looped');
  if ((clip.takes?.length ?? 0) > 0) throw new TuneToMidiRefusedError('comped');

  const asset = await deps.loadAudioAsset(clip.assetId);
  const { sampleRate } = asset.meta;
  const targets = midiNoteTargets(midiClips, tempo, clip.startPpq - clip.sourceOffsetPpq);
  if (targets.length === 0) throw new TuneToMidiRefusedError('no-notes');

  const mono = downmixToMono(asset.channels);
  const contour = deps.pitchPyin(mono, sampleRate, NOTE_DETECT_FRAME, NOTE_DETECT_HOP);
  const notes = deps.extractNotes({
    samples: mono,
    sampleRate,
    f0Hz: contour.f0,
    frameRate: sampleRate / NOTE_DETECT_HOP,
    voiced: Array.from(contour.voicedFlag, Boolean),
    segmentationThresholdCents: NOTE_DETECT_THRESHOLD_CENTS,
  });
  const assigned = deps.assignNoteTargets({
    notes,
    sampleRate,
    targets,
    unmatchedPolicy: policy,
  });
  const channels = asset.channels.map((channel) =>
    deps.renderNotes({ samples: channel, sampleRate, notes: assigned.notes }),
  );
  return { channels, sampleRate, noteCount: notes.length, assignedCount: assigned.assignedCount };
}
