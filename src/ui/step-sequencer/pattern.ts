/**
 * Step-sequencer pattern model.
 *
 * The pattern is the editing source; MIDI notes are generated output (see
 * bake.ts). All operations are pure: they return new pattern objects and
 * never mutate their input, so the editing component can hold the pattern in
 * a single ref and tests can compare snapshots. Pattern state is currently
 * session-local component state; document serialization is deferred.
 */

import { DEFAULT_DRUM_KIT, pitchName } from './drum-map';

/** Step grid rates relative to a quarter note (T = triplet). */
export type StepResolution = '1/8' | '1/16' | '1/8T' | '1/16T';

/** All selectable resolutions, in menu order. */
export const STEP_RESOLUTIONS: ReadonlyArray<StepResolution> = ['1/8', '1/16', '1/8T', '1/16T'];

/** Selectable pattern lengths in steps. */
export const STEP_COUNTS = [8, 16, 32] as const;

/** One of the selectable pattern lengths. */
export type StepCount = (typeof STEP_COUNTS)[number];

/** Row labeling / pitch layout mode. */
export type SequencerMode = 'drum' | 'pitch';

/** Velocity assigned to steps that have never been edited. */
export const DEFAULT_STEP_VELOCITY = 96;
/** Gate assigned to steps that have never been edited (fraction of a step). */
export const DEFAULT_STEP_GATE = 0.5;
/** Smallest allowed gate (fraction of a step; keeps note durations > 0). */
export const MIN_GATE = 0.05;
/** Largest allowed gate (full step, legato). */
export const MAX_GATE = 1;
/** Largest allowed micro-timing offset magnitude (fraction of a step). */
export const MAX_OFFSET = 0.5;
/** Number of chromatic rows generated in pitch mode. */
export const PITCH_MODE_ROW_COUNT = 12;

/** One grid cell. Velocity/gate/offset are kept even while inactive. */
export interface PatternStep {
  /** Whether the step emits a note when baked. */
  active: boolean;
  /** Note-on velocity (integer, 1-127). */
  velocity: number;
  /** Note length as a fraction of the step duration (MIN_GATE..MAX_GATE). */
  gate: number;
  /** Micro-timing shift as a fraction of the step duration (-0.5..0.5). */
  offset: number;
}

/** One sequencer lane bound to a fixed MIDI pitch. */
export interface PatternRow {
  /** MIDI pitch the row bakes to. */
  pitch: number;
  /** Display label (GM drum name or pitch name). */
  name: string;
  /** Muted rows are skipped when baking. */
  muted: boolean;
  /** Cells, one per pattern step. */
  steps: PatternStep[];
}

/** The whole editable pattern. */
export interface StepPattern {
  /** Drum rows (GM kit pitches) or chromatic pitch rows. */
  mode: SequencerMode;
  /** MIDI channel emitted by every row (the current pattern is single-channel). */
  channel: number;
  /** Number of steps per row. */
  stepCount: StepCount;
  /** Step rate. */
  resolution: StepResolution;
  /** Swing amount in percent (0-100); see timing.ts for the exact law. */
  swing: number;
  /** Seed for the deterministic randomize operations. */
  seed: number;
  /** Lanes in display order (top to bottom). */
  rows: PatternRow[];
}

/** Clamps and rounds a velocity into the valid MIDI range (1-127). */
export function clampVelocity(value: number): number {
  return Math.min(127, Math.max(1, Math.round(value)));
}

/** Clamps a gate fraction into [MIN_GATE, MAX_GATE]. */
export function clampGate(value: number): number {
  return Math.min(MAX_GATE, Math.max(MIN_GATE, value));
}

/** Clamps a micro-timing offset into [-MAX_OFFSET, MAX_OFFSET]. */
export function clampOffset(value: number): number {
  return Math.min(MAX_OFFSET, Math.max(-MAX_OFFSET, value));
}

/** Creates a step with default values, optionally overridden. */
export function createStep(overrides: Partial<PatternStep> = {}): PatternStep {
  return {
    active: false,
    velocity: DEFAULT_STEP_VELOCITY,
    gate: DEFAULT_STEP_GATE,
    offset: 0,
    ...overrides,
  };
}

function createRow(pitch: number, name: string, stepCount: number): PatternRow {
  return {
    pitch,
    name,
    muted: false,
    steps: Array.from({ length: stepCount }, () => createStep()),
  };
}

/**
 * Creates an empty drum pattern over the default GM kit subset.
 *
 * @param stepCount Steps per row (default 16).
 * @param resolution Step rate (default 1/16).
 */
export function createDrumPattern(
  stepCount: StepCount = 16,
  resolution: StepResolution = '1/16',
): StepPattern {
  return {
    mode: 'drum',
    channel: 9,
    stepCount,
    resolution,
    swing: 0,
    seed: 1,
    rows: DEFAULT_DRUM_KIT.map((row) => createRow(row.pitch, row.name, stepCount)),
  };
}

/**
 * Creates an empty pitch-mode pattern: one chromatic octave from the root,
 * highest pitch first (top row).
 *
 * @param rootPitch Lowest pitch of the octave (integer, 0-115; default C3).
 * @param stepCount Steps per row (default 16).
 * @param resolution Step rate (default 1/16).
 */
export function createPitchPattern(
  rootPitch = 48,
  stepCount: StepCount = 16,
  resolution: StepResolution = '1/16',
): StepPattern {
  const root = Math.min(127 - (PITCH_MODE_ROW_COUNT - 1), Math.max(0, Math.round(rootPitch)));
  const rows = Array.from({ length: PITCH_MODE_ROW_COUNT }, (_, i) => {
    const pitch = root + PITCH_MODE_ROW_COUNT - 1 - i;
    return createRow(pitch, pitchName(pitch), stepCount);
  });
  return { mode: 'pitch', channel: 0, stepCount, resolution, swing: 0, seed: 1, rows };
}

/** Deep-copies a pattern. */
export function clonePattern(pattern: StepPattern): StepPattern {
  return {
    ...pattern,
    rows: pattern.rows.map((row) => ({ ...row, steps: row.steps.map((step) => ({ ...step })) })),
  };
}

function requireRow(pattern: StepPattern, rowIndex: number): PatternRow {
  const row = pattern.rows[rowIndex];
  if (!row) throw new RangeError(`Unknown pattern row index: ${rowIndex}`);
  return row;
}

function requireStep(row: PatternRow, stepIndex: number): PatternStep {
  const step = row.steps[stepIndex];
  if (!step) throw new RangeError(`Unknown pattern step index: ${stepIndex}`);
  return step;
}

function mapRow(
  pattern: StepPattern,
  rowIndex: number,
  transform: (row: PatternRow) => PatternRow,
): StepPattern {
  requireRow(pattern, rowIndex);
  return {
    ...pattern,
    rows: pattern.rows.map((row, i) => (i === rowIndex ? transform(row) : row)),
  };
}

/**
 * Resizes every row to a new step count: extra steps are dropped, missing
 * steps are appended with defaults.
 */
export function withStepCount(pattern: StepPattern, stepCount: StepCount): StepPattern {
  if (stepCount === pattern.stepCount) return pattern;
  return {
    ...pattern,
    stepCount,
    rows: pattern.rows.map((row) => ({
      ...row,
      steps: Array.from({ length: stepCount }, (_, i) =>
        row.steps[i] ? { ...row.steps[i] } : createStep(),
      ),
    })),
  };
}

/** Changes the step rate; steps keep their indices (same steps, new tempo grid). */
export function withResolution(pattern: StepPattern, resolution: StepResolution): StepPattern {
  if (resolution === pattern.resolution) return pattern;
  return { ...pattern, resolution };
}

/** Sets the swing amount, clamped to 0-100 percent. */
export function withSwing(pattern: StepPattern, swing: number): StepPattern {
  const clamped = Math.min(100, Math.max(0, swing));
  if (clamped === pattern.swing) return pattern;
  return { ...pattern, swing: clamped };
}

/** Flips a step's active flag, keeping its stored velocity/gate/offset. */
export function toggledStep(
  pattern: StepPattern,
  rowIndex: number,
  stepIndex: number,
): StepPattern {
  return withStep(pattern, rowIndex, stepIndex, {
    active: !requireStep(requireRow(pattern, rowIndex), stepIndex).active,
  });
}

/**
 * Applies a partial edit to one step. Velocity, gate and offset values are
 * clamped into their valid ranges.
 */
export function withStep(
  pattern: StepPattern,
  rowIndex: number,
  stepIndex: number,
  patch: Partial<PatternStep>,
): StepPattern {
  return mapRow(pattern, rowIndex, (row) => {
    requireStep(row, stepIndex);
    return {
      ...row,
      steps: row.steps.map((step, i) => {
        if (i !== stepIndex) return step;
        const next = { ...step, ...patch };
        next.velocity = clampVelocity(next.velocity);
        next.gate = clampGate(next.gate);
        next.offset = clampOffset(next.offset);
        return next;
      }),
    };
  });
}

/** Sets a row's mute flag. */
export function withRowMuted(pattern: StepPattern, rowIndex: number, muted: boolean): StepPattern {
  return mapRow(pattern, rowIndex, (row) => ({ ...row, muted }));
}

/** Resets every step of a row to defaults (inactive). */
export function clearedRow(pattern: StepPattern, rowIndex: number): StepPattern {
  return mapRow(pattern, rowIndex, (row) => ({
    ...row,
    steps: row.steps.map(() => createStep()),
  }));
}

/**
 * Rotates a row's steps. Positive delta moves content toward later steps
 * (shift right) with wrap-around; negative shifts left.
 */
export function shiftedRow(pattern: StepPattern, rowIndex: number, delta: number): StepPattern {
  return mapRow(pattern, rowIndex, (row) => {
    const count = row.steps.length;
    if (count === 0) return row;
    const shift = ((Math.round(delta) % count) + count) % count;
    if (shift === 0) return { ...row };
    return {
      ...row,
      steps: row.steps.map((_, i) => ({ ...row.steps[(i - shift + count) % count] })),
    };
  });
}

/**
 * Replaces a row's active flags (used by the euclidean fill). Inactive cells
 * keep their stored velocity/gate/offset.
 *
 * @param activeFlags One flag per step; shorter arrays leave the tail inactive.
 */
export function withRowFill(
  pattern: StepPattern,
  rowIndex: number,
  activeFlags: ReadonlyArray<boolean>,
): StepPattern {
  return mapRow(pattern, rowIndex, (row) => ({
    ...row,
    steps: row.steps.map((step, i) => ({ ...step, active: activeFlags[i] === true })),
  }));
}
