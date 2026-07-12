/**
 * Counter-melody generation command.
 *
 * Writes a counter line against the active MIDI clip's melody with libcantus's
 * `generateCounterMelody`, landing it on a new track. The melody is reduced to
 * a single voice first ({@link topVoiceOnly}) — the generator assumes one voice
 * — and the sounding chord at each beat comes from the project chord timeline.
 * Output is deterministic in `seed`.
 *
 * Requires an active MIDI clip with notes; otherwise the command is a no-op.
 */

import { type CounterMelodyOptions, generateCounterMelody } from '@libraz/libcantus';
import { buildChordTimeline } from '@/compose/chord-at-tick';
import { effectiveKeyScale } from '@/compose/key';
import { editorNotesToNoteEvents, noteEventsToNewEditorNotes } from '@/compose/notes-io';
import { topVoiceOnly } from '@/compose/tracks';
import { useProjectStore } from '../store';
import {
  addGeneratedTrack,
  EDITS_PER_TRACK,
  materializeNote,
  type TrackPlan,
} from './generate-track';
import { execute } from './history';

/** NativeSynth preset for generated counter-melody tracks. */
const COUNTER_PRESET = 'pluck';

/** Options for {@link generateCounterMelodyCommand}. */
export interface GenerateCounterMelodyParams {
  /** Which side of the melody the counter line occupies (default 'below'). */
  register?: CounterMelodyOptions['register'];
  /** Onset strategy: 'complement' fills rests, 'follow' mirrors onsets (default 'complement'). */
  rhythm?: CounterMelodyOptions['rhythm'];
  /** Safety profile for candidate pitches (default 'pop'). */
  profile?: CounterMelodyOptions['profile'];
  /** Deterministic seed (default 0). */
  seed?: number;
}

/**
 * Builds the counter-melody plan for a new track without writing to the
 * Project.
 *
 * @returns The plan, or null when the active clip has no melody.
 * @throws Error when there is no active clip.
 */
export function buildCounterPlan(
  store: ReturnType<typeof useProjectStore>,
  params: GenerateCounterMelodyParams = {},
): TrackPlan | null {
  const clip = store.activeClip;
  if (clip === null) throw new Error('No active clip for a counter melody');
  if (clip.notes.length === 0) return null;

  const melody = topVoiceOnly(editorNotesToNoteEvents(clip.notes, clip.startPpq));
  if (melody.length === 0) return null;
  const melodyEndBeat = melody.reduce(
    (max, note) => Math.max(max, note.startBeat + note.durationBeat),
    0,
  );

  const key = effectiveKeyScale(store.scaleHighlight);
  const timeline = buildChordTimeline(store.chords);

  const events = generateCounterMelody({
    melody,
    chordAt: (beat) => timeline.at(beat),
    key,
    ...(params.register !== undefined ? { register: params.register } : {}),
    ...(params.rhythm !== undefined ? { rhythm: params.rhythm } : {}),
    ...(params.profile !== undefined ? { profile: params.profile } : {}),
    seed: params.seed ?? 0,
  });

  const notes = noteEventsToNewEditorNotes(events, { channel: 0 }).map(materializeNote);
  if (notes.length === 0) return null;
  return { name: 'Counter melody', notes, lengthPpq: melodyEndBeat, preset: COUNTER_PRESET };
}

/**
 * Generates a counter melody against the active clip's melody.
 *
 * @param params Generation options (see {@link GenerateCounterMelodyParams}).
 * @returns The number of counter notes written (0 when there is no melody).
 * @throws Error when there is no active clip.
 */
export function generateCounterMelodyCommand(params: GenerateCounterMelodyParams = {}): number {
  const store = useProjectStore();
  const plan = buildCounterPlan(store, params);
  if (plan === null) return 0;

  execute(EDITS_PER_TRACK, () =>
    addGeneratedTrack(store, {
      name: plan.name,
      notes: plan.notes,
      startPpq: 0,
      lengthPpq: plan.lengthPpq,
      preset: plan.preset,
    }),
  );
  return plan.notes.length;
}
