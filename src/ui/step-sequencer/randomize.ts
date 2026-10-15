/**
 * Seeded pattern randomization.
 *
 * Every draw is addressed by the cell it belongs to rather than taken in call
 * order, so a cell's value depends on the seed and its own row and step and
 * nothing else. That is what makes a result independent of the grid's size and
 * of which steps happen to be active: growing the pattern, or activating a step
 * elsewhere, cannot shift the draws of the cells around it.
 *
 * Each operation draws under its own name, so one seed gives jitter and fill
 * independent randomness rather than two readings of one stream.
 */

import { createPositionalRng, deriveSeed } from '@libraz/libcantus';
import { clamp } from '@/lib/math';
import { clampVelocity, clonePattern, DEFAULT_STEP_VELOCITY, type StepPattern } from './pattern';

/** A cell-addressed random source for one operation, from the pattern's seed. */
function cellRng(seed: number, operation: string): (row: number, step: number) => number {
  const rng = createPositionalRng(deriveSeed(Math.trunc(seed) >>> 0, operation));
  return (row, step) => rng.at(row, step);
}

/** Options for {@link jitterVelocities}. */
export interface VelocityJitterOptions {
  /** PRNG seed. */
  seed: number;
  /** Maximum velocity deviation in either direction (0-64). */
  amount: number;
}

/**
 * Applies a deterministic random velocity deviation to every active step.
 * The deviation is uniform in [-amount, +amount] and the result is clamped
 * to the valid 1-127 range.
 */
export function jitterVelocities(
  pattern: StepPattern,
  options: VelocityJitterOptions,
): StepPattern {
  const amount = clamp(options.amount, 0, 64);
  const random = cellRng(options.seed, 'jitter');
  const next = clonePattern(pattern);
  next.rows.forEach((row, rowIndex) => {
    row.steps.forEach((step, stepIndex) => {
      if (!step.active) return;
      const delta = Math.round((random(rowIndex, stepIndex) * 2 - 1) * amount);
      step.velocity = clampVelocity(step.velocity + delta);
    });
  });
  return next;
}

/** Options for {@link sparseFill}. */
export interface SparseFillOptions {
  /** PRNG seed. */
  seed: number;
  /** Probability that a cell becomes active (0-1). */
  density: number;
  /**
   * When true (default), velocities of newly activated cells are reset to
   * the default so a fill starts from a uniform dynamic level.
   */
  resetVelocity?: boolean;
}

/**
 * Replaces every row's active flags with a deterministic sparse fill: each
 * cell becomes active with the given probability. Muted rows are filled too
 * (they stay silent until unmuted); gates and offsets are preserved.
 */
export function sparseFill(pattern: StepPattern, options: SparseFillOptions): StepPattern {
  const density = clamp(options.density, 0, 1);
  const resetVelocity = options.resetVelocity ?? true;
  const random = cellRng(options.seed, 'fill');
  const next = clonePattern(pattern);
  next.rows.forEach((row, rowIndex) => {
    row.steps.forEach((step, stepIndex) => {
      const wasActive = step.active;
      step.active = random(rowIndex, stepIndex) < density;
      if (step.active && !wasActive && resetVelocity) step.velocity = DEFAULT_STEP_VELOCITY;
    });
  });
  return next;
}
