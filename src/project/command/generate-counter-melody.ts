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
import { createGenerationTargetFrame } from '@/compose/generation-target';
import { effectiveKeyScale } from '@/compose/key';
import { editorNotesToNoteEvents, noteEventsToNewEditorNotes } from '@/compose/notes-io';
import { topVoiceOnly } from '@/compose/tracks';
import { trackProvenance } from '../generation';
import { projectMidiNoteOccurrences } from '../midi-projection';
import { useProjectStore } from '../store';
import { addGeneratedTrack, materializeNote, type TrackPlan } from './generate-track';
import { executeAtomic } from './history';

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
  const projected = projectMidiNoteOccurrences(clip);
  if (projected.length === 0) return null;

  const melody = topVoiceOnly(editorNotesToNoteEvents(projected));
  if (melody.length === 0) return null;
  const melodyEndBeat = melody.reduce(
    (max, note) => Math.max(max, note.startBeat + note.durationBeat),
    0,
  );

  const key = effectiveKeyScale(store.scaleHighlight);
  const target = createGenerationTargetFrame({
    startPpq: clip.startPpq,
    endPpq: clip.startPpq + clip.lengthPpq,
    chords: store.chords,
    timeSignatures: store.timeSignatures,
  });

  const events = generateCounterMelody({
    melody,
    chordAt: (beat) => target.chordAt(beat),
    key,
    ...(params.register !== undefined ? { register: params.register } : {}),
    ...(params.rhythm !== undefined ? { rhythm: params.rhythm } : {}),
    ...(params.profile !== undefined ? { profile: params.profile } : {}),
    ctx: { seed: params.seed ?? 0 },
  });

  const notes = noteEventsToNewEditorNotes(events, { channel: 0 }).map(materializeNote);
  if (notes.length === 0) return null;
  return {
    name: 'Counter melody',
    notes,
    lengthPpq: melodyEndBeat,
    preset: COUNTER_PRESET,
    provenance: trackProvenance('counter', params.seed ?? 0),
  };
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

  executeAtomic((edit) =>
    addGeneratedTrack(
      store,
      {
        name: plan.name,
        notes: plan.notes,
        startPpq: 0,
        lengthPpq: plan.lengthPpq,
        preset: plan.preset,
        provenance: plan.provenance,
      },
      edit,
    ),
  );
  return plan.notes.length;
}
