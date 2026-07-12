/**
 * Drum-generation command.
 *
 * Generates a drum performance with libcantus's `generateDrums` and lays it on
 * a new track whose notes sit on the GM percussion channel (MIDI channel 10,
 * zero-based 9). Each {@link DrumHit} carries its General MIDI pitch, so the
 * track reads back as percussion and the harmonic surfaces exclude it (see
 * src/compose/tracks.ts). Output is deterministic in `seed`.
 *
 * libcantus assumes a four-beat bar; non-4/4 projects still get a 4/4 grid
 * (drum meter support is a library concern), which the dialog surfaces.
 */

import { type DrumsOptions, generateDrums } from '@libraz/libcantus';
import { noteEventsToNewEditorNotes } from '@/compose/notes-io';
import { useProjectStore } from '../store';
import {
  addGeneratedTrack,
  EDITS_PER_TRACK,
  materializeNote,
  type TrackPlan,
} from './generate-track';
import { execute } from './history';

/** GM percussion channel (MIDI channel 10, zero-based). */
const GM_PERCUSSION_CHANNEL = 9;

/** Beats per bar the drum generator assumes (4/4). */
const BEATS_PER_BAR = 4;

/** NativeSynth preset for generated drum tracks. */
const DRUMS_PRESET = 'drum-kit';

/** Options for {@link generateDrumsCommand}. */
export interface GenerateDrumsParams {
  /** Number of four-beat bars (default 4). */
  bars?: number;
  /** Groove style (default 'standard'). */
  style?: DrumsOptions['style'];
  /** Section shaping density and fills (default 'verse'). */
  section?: DrumsOptions['section'];
  /** Backing density in [0, 1] (default 0.6). */
  density?: number;
  /** Replace the final bar with a fill (default false). */
  fills?: boolean;
  /** Section the final-bar fill leads into (default: same as `section`). */
  nextSection?: DrumsOptions['section'];
  /** Groove feel (default derived from style). */
  feel?: DrumsOptions['feel'];
  /** Voicing role gating which voices sound (default 'full'). */
  role?: DrumsOptions['role'];
  /** Euclidean kick override, replacing the style/section kick pattern. */
  euclideanKick?: DrumsOptions['euclideanKick'];
  /** Deterministic seed (default 0). */
  seed?: number;
}

/**
 * Builds the drum-track plan for a new track without writing to the Project, so
 * both the single-shot command and the batch command can consume it.
 *
 * @returns The plan, or null when no hits were generated.
 * @throws RangeError when `bars` is not a positive integer.
 */
export function buildDrumsPlan(
  store: ReturnType<typeof useProjectStore>,
  params: GenerateDrumsParams = {},
): TrackPlan | null {
  const bars = params.bars ?? 4;
  if (!Number.isInteger(bars) || bars <= 0) {
    throw new RangeError(`Drum bars must be a positive integer, got ${bars}`);
  }
  const section = params.section ?? 'verse';

  const hits = generateDrums({
    bars,
    bpm: store.tempoBpm,
    style: params.style ?? 'standard',
    section,
    density: params.density ?? 0.6,
    ...(params.fills !== undefined ? { fills: params.fills } : {}),
    ...(params.nextSection !== undefined ? { nextSection: params.nextSection } : {}),
    ...(params.feel !== undefined ? { feel: params.feel } : {}),
    ...(params.role !== undefined ? { role: params.role } : {}),
    ...(params.euclideanKick !== undefined ? { euclideanKick: params.euclideanKick } : {}),
    seed: params.seed ?? 0,
  });

  const notes = noteEventsToNewEditorNotes(hits, { channel: GM_PERCUSSION_CHANNEL }).map(
    materializeNote,
  );
  if (notes.length === 0) return null;
  return { name: 'Drums', notes, lengthPpq: bars * BEATS_PER_BAR, preset: DRUMS_PRESET };
}

/**
 * Generates a drum track for the project tempo.
 *
 * @param params Generation options (see {@link GenerateDrumsParams}).
 * @returns The number of drum hits written (0 when none were generated).
 * @throws RangeError when `bars` is not a positive integer.
 */
export function generateDrumsCommand(params: GenerateDrumsParams = {}): number {
  const store = useProjectStore();
  const plan = buildDrumsPlan(store, params);
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
