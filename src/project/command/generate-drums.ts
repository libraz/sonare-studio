/**
 * Drum-generation command.
 *
 * Generates a drum performance with libcantus's `generateDrums` and lays it on
 * a new track whose notes sit on the GM percussion channel (MIDI channel 10,
 * zero-based 9). Each {@link DrumHit} carries its General MIDI pitch, so the
 * track reads back as percussion and the harmonic surfaces exclude it (see
 * src/compose/tracks.ts). Output is deterministic in `seed`.
 *
 * libcantus assumes a four-beat bar; non-4/4 projects are rejected for the
 * requested range (drum meter support is a library concern), which the dialog
 * surfaces.
 */

import {
  type DrumsOptions,
  generateDrums,
  MAX_DIFFICULTY,
  MIN_DIFFICULTY,
} from '@libraz/libcantus';
import { noteEventsToNewEditorNotes } from '@/compose/notes-io';
import { GM_PERCUSSION_CHANNEL } from '@/compose/tracks';
import { trackProvenance } from '../generation';
import { useProjectStore } from '../store';
import { normalizeTempoMap, tempoAtPpq } from '../tempo-map';
import { isFourFourBarRange } from '../time-signature';
import { commitTrackPlan, materializeNote, type TrackPlan } from './generate-track';

/** Beats per bar the drum generator assumes (4/4). */
const BEATS_PER_BAR = 4;

/** NativeSynth preset for generated drum tracks. */
const DRUMS_PRESET = 'drumKit';

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
  /**
   * Hardest the groove may be to play, from {@link MIN_DRUM_DIFFICULTY} to
   * {@link MAX_DRUM_DIFFICULTY}; omitted leaves the groove unconstrained.
   *
   * A ceiling rather than an intensity: it rejects strokes the density asked
   * for and the tempo makes too fast to sustain, so the same setting thins the
   * groove more at a quick tempo than at a slow one.
   */
  difficulty?: number;
  /** Deterministic seed (default 0). */
  seed?: number;
}

/** Lowest playing-difficulty ceiling: what a beginner sustains. */
export const MIN_DRUM_DIFFICULTY: number = MIN_DIFFICULTY;

/** Highest playing-difficulty ceiling: at the limit of the instrument. */
export const MAX_DRUM_DIFFICULTY: number = MAX_DIFFICULTY;

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
  startPpq = 0,
): TrackPlan | null {
  const bars = params.bars ?? 4;
  if (!Number.isInteger(bars) || bars <= 0) {
    throw new RangeError(`Drum bars must be a positive integer, got ${bars}`);
  }
  if (!Number.isFinite(startPpq) || startPpq < 0) {
    throw new RangeError(`Drum startPpq must be finite and >= 0, got ${startPpq}`);
  }
  if (!isFourFourBarRange(store.timeSignatures, startPpq, bars)) {
    throw new RangeError('Drum generation currently supports 4/4 bars only.');
  }
  const section = params.section ?? 'verse';

  const hits = generateDrums({
    bars,
    style: params.style ?? 'standard',
    section,
    ...(params.fills !== undefined ? { fills: params.fills } : {}),
    ...(params.nextSection !== undefined ? { nextSection: params.nextSection } : {}),
    ...(params.feel !== undefined ? { feel: params.feel } : {}),
    ...(params.role !== undefined ? { role: params.role } : {}),
    ...(params.euclideanKick !== undefined ? { euclideanKick: params.euclideanKick } : {}),
    ctx: {
      seed: params.seed ?? 0,
      bpm: tempoAtPpq(normalizeTempoMap(store.tempoSegments, store.tempoBpm), startPpq),
      complexity: {
        rhythmic: params.density ?? 0.6,
        ...(params.difficulty !== undefined ? { difficulty: params.difficulty } : {}),
      },
    },
  });

  const notes = noteEventsToNewEditorNotes(hits, { channel: GM_PERCUSSION_CHANNEL }).map(
    materializeNote,
  );
  if (notes.length === 0) return null;
  return {
    name: 'Drums',
    notes,
    lengthPpq: bars * BEATS_PER_BAR,
    preset: DRUMS_PRESET,
    provenance: trackProvenance('drums', params.seed ?? 0),
  };
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

  return commitTrackPlan(store, plan);
}
