/**
 * PPQ math for the step sequencer.
 *
 * The project's PPQ unit is the quarter note (the editor grid uses
 * gridPpq = 4 / snapDivision, so a whole note spans 4.0). Swing follows the
 * common DAW law: every off-beat (odd-indexed) step of a straight grid is
 * delayed by up to one third of a step, so 100% swing lands the off-beat on
 * the perfect triplet position (66.7% of the step pair). Triplet resolutions
 * are already swung by construction and ignore the swing amount.
 */

import { MAX_OFFSET, type StepResolution } from './pattern';

/** Step duration in PPQ (quarter-note units) for each resolution. */
const STEP_DURATIONS: Readonly<Record<StepResolution, number>> = {
  '1/8': 0.5,
  '1/16': 0.25,
  '1/8T': 1 / 3,
  '1/16T': 1 / 6,
};

/** Returns one step's duration in PPQ for a resolution. */
export function stepDurationPpq(resolution: StepResolution): number {
  return STEP_DURATIONS[resolution];
}

/** True for triplet resolutions (swing does not apply to them). */
export function isTripletResolution(resolution: StepResolution): boolean {
  return resolution === '1/8T' || resolution === '1/16T';
}

/**
 * Swing delay in PPQ applied to a step.
 *
 * @param stepIndex Zero-based step index; only odd indices are delayed.
 * @param resolution Step rate.
 * @param swing Swing amount in percent (0-100); 100 = triplet feel.
 */
export function swingShiftPpq(
  stepIndex: number,
  resolution: StepResolution,
  swing: number,
): number {
  if (stepIndex % 2 === 0 || isTripletResolution(resolution)) return 0;
  const amount = Math.min(100, Math.max(0, swing)) / 100;
  return (amount * stepDurationPpq(resolution)) / 3;
}

/**
 * Start position of a step in PPQ, relative to the pattern origin.
 *
 * @param stepIndex Zero-based step index.
 * @param resolution Step rate.
 * @param swing Swing amount in percent (0-100).
 * @param offset Per-step micro-timing shift as a fraction of the step
 *   duration (-0.5..0.5). The result is clamped to >= 0 so a negative offset
 *   on the first step cannot move it before the pattern origin.
 */
export function stepStartPpq(
  stepIndex: number,
  resolution: StepResolution,
  swing: number,
  offset = 0,
): number {
  const duration = stepDurationPpq(resolution);
  const start =
    stepIndex * duration + swingShiftPpq(stepIndex, resolution, swing) + offset * duration;
  return Math.max(0, start);
}

/** Result of snapping a PPQ position back onto the swung step grid. */
export interface StepSnap {
  /** Zero-based index of the nearest step. */
  step: number;
  /** Residual micro-timing as a fraction of the step duration, clamped to ±0.5. */
  offset: number;
}

/**
 * Inverse of {@link stepStartPpq}: finds the step whose swung start is
 * nearest to a PPQ position and the residual offset. Used by "Pull from
 * clip" to map existing notes back onto the grid.
 *
 * @param ppq Position relative to the pattern origin (>= 0).
 * @param resolution Step rate.
 * @param swing Swing amount in percent (0-100).
 * @param stepCount Number of steps in the pattern.
 * @returns The snap, or null when the position lies beyond the pattern end
 *   (further than half a step after the last step's swung start).
 */
export function nearestStepForPpq(
  ppq: number,
  resolution: StepResolution,
  swing: number,
  stepCount: number,
): StepSnap | null {
  if (!Number.isFinite(ppq) || ppq < 0 || stepCount < 1) return null;
  const duration = stepDurationPpq(resolution);
  const guess = Math.round(ppq / duration);
  let best: StepSnap | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let step = guess - 1; step <= guess + 1; step++) {
    if (step < 0 || step >= stepCount) continue;
    const distance = ppq - stepStartPpq(step, resolution, swing, 0);
    if (Math.abs(distance) < Math.abs(bestDistance)) {
      bestDistance = distance;
      best = { step, offset: distance / duration };
    }
  }
  if (!best) {
    // Position is past the last step: keep it only within half a step.
    const last = stepCount - 1;
    const distance = ppq - stepStartPpq(last, resolution, swing, 0);
    if (distance >= 0 && distance / duration <= MAX_OFFSET) {
      return { step: last, offset: distance / duration };
    }
    return null;
  }
  if (best.offset > MAX_OFFSET && best.step === stepCount - 1) return null;
  best.offset = Math.min(MAX_OFFSET, Math.max(-MAX_OFFSET, best.offset));
  return best;
}

/**
 * Step sounding at a clip-source position, for the playback highlight. Swing is
 * ignored so the highlight advances on the straight grid.
 *
 * @returns The step index, or null outside the pattern span.
 */
export function stepIndexAtPpq(
  sourcePpq: number,
  basePpq: number,
  stepCount: number,
  resolution: StepResolution,
): number | null {
  const step = Math.floor((sourcePpq - basePpq) / stepDurationPpq(resolution));
  return Number.isFinite(step) && step >= 0 && step < stepCount ? step : null;
}

/** Total pattern span in PPQ (without swing or offsets). */
export function patternLengthPpq(stepCount: number, resolution: StepResolution): number {
  return stepCount * stepDurationPpq(resolution);
}
