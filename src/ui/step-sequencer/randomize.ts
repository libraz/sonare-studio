/**
 * Seeded pattern randomization. Every operation consumes the PRNG stream in
 * a fixed row-major order over all cells (active or not), so the same seed
 * always produces the same result for a given grid size regardless of which
 * steps happen to be active.
 */

import { clampVelocity, clonePattern, DEFAULT_STEP_VELOCITY, type StepPattern } from './pattern';
import { mulberry32 } from './prng';

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
  const amount = Math.min(64, Math.max(0, options.amount));
  const random = mulberry32(options.seed);
  const next = clonePattern(pattern);
  for (const row of next.rows) {
    for (const step of row.steps) {
      // Consume one sample per cell to keep the stream position stable.
      const delta = Math.round((random() * 2 - 1) * amount);
      if (step.active) step.velocity = clampVelocity(step.velocity + delta);
    }
  }
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
  const density = Math.min(1, Math.max(0, options.density));
  const resetVelocity = options.resetVelocity ?? true;
  const random = mulberry32(options.seed);
  const next = clonePattern(pattern);
  for (const row of next.rows) {
    for (const step of row.steps) {
      const wasActive = step.active;
      step.active = random() < density;
      if (step.active && !wasActive && resetVelocity) step.velocity = DEFAULT_STEP_VELOCITY;
    }
  }
  return next;
}
