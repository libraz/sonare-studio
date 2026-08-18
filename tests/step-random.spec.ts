import { describe, expect, it } from 'vitest';
import { createDrumPattern, DEFAULT_STEP_VELOCITY, withStep } from '@/ui/step-sequencer/pattern';
import { jitterVelocities, sparseFill } from '@/ui/step-sequencer/randomize';

describe('jitterVelocities', () => {
  function activePattern() {
    let pattern = createDrumPattern(8);
    pattern = withStep(pattern, 0, 0, { active: true, velocity: 96 });
    pattern = withStep(pattern, 0, 4, { active: true, velocity: 96 });
    pattern = withStep(pattern, 5, 2, { active: true, velocity: 96 });
    return pattern;
  }

  it('is reproducible for the same seed and differs across seeds', () => {
    const pattern = activePattern();
    const first = jitterVelocities(pattern, { seed: 7, amount: 20 });
    const second = jitterVelocities(pattern, { seed: 7, amount: 20 });
    expect(second).toEqual(first);
    const other = jitterVelocities(pattern, { seed: 8, amount: 20 });
    expect(other).not.toEqual(first);
  });

  it('only changes active steps and clamps into 1-127', () => {
    let pattern = activePattern();
    pattern = withStep(pattern, 0, 0, { velocity: 127 });
    pattern = withStep(pattern, 0, 4, { velocity: 1 });
    const result = jitterVelocities(pattern, { seed: 3, amount: 64 });
    for (let r = 0; r < result.rows.length; r++) {
      for (let s = 0; s < result.rows[r].steps.length; s++) {
        const step = result.rows[r].steps[s];
        const before = pattern.rows[r].steps[s];
        if (!step.active) {
          expect(step.velocity).toBe(before.velocity);
        } else {
          expect(step.velocity).toBeGreaterThanOrEqual(1);
          expect(step.velocity).toBeLessThanOrEqual(127);
        }
        expect(step.active).toBe(before.active);
      }
    }
  });

  it('gives each cell a stable deviation independent of other activations', () => {
    const sparse = activePattern();
    const dense = withStep(sparse, 9, 7, { active: true });
    const fromSparse = jitterVelocities(sparse, { seed: 11, amount: 30 });
    const fromDense = jitterVelocities(dense, { seed: 11, amount: 30 });
    expect(fromDense.rows[0].steps[0].velocity).toBe(fromSparse.rows[0].steps[0].velocity);
    expect(fromDense.rows[5].steps[2].velocity).toBe(fromSparse.rows[5].steps[2].velocity);
  });

  /**
   * A draw belongs to its cell, not to a position in a stream, so lengthening
   * the pattern cannot redraw the steps already in it. Taking the draws in call
   * order made every cell's value depend on how many cells came before it.
   */
  it('leaves the existing steps alone when the grid grows', () => {
    const short = withStep(createDrumPattern(8), 0, 0, { active: true, velocity: 96 });
    const long = withStep(createDrumPattern(16), 0, 0, { active: true, velocity: 96 });

    expect(jitterVelocities(long, { seed: 13, amount: 30 }).rows[0].steps[0].velocity).toBe(
      jitterVelocities(short, { seed: 13, amount: 30 }).rows[0].steps[0].velocity,
    );
  });

  // One seed feeds both operations, so they must not read the same draws.
  it('draws jitter and fill independently from one seed', () => {
    const grid = createDrumPattern(8);
    const filled = sparseFill(grid, { seed: 21, density: 0.5 });
    const jittered = jitterVelocities(sparseFill(grid, { seed: 21, density: 1 }), {
      seed: 21,
      amount: 40,
    });
    const fillDraws = filled.rows.map((row) => row.steps.map((step) => step.active));
    const jitterUp = jittered.rows.map((row) =>
      row.steps.map((step) => step.velocity > DEFAULT_STEP_VELOCITY),
    );

    expect(jitterUp).not.toEqual(fillDraws);
  });

  it('amount 0 leaves the pattern untouched', () => {
    const pattern = activePattern();
    expect(jitterVelocities(pattern, { seed: 5, amount: 0 })).toEqual(pattern);
  });
});

describe('sparseFill', () => {
  it('density 0 clears and density 1 fills every cell', () => {
    const pattern = createDrumPattern(8);
    const none = sparseFill(pattern, { seed: 1, density: 0 });
    expect(none.rows.every((row) => row.steps.every((step) => !step.active))).toBe(true);
    const all = sparseFill(pattern, { seed: 1, density: 1 });
    expect(all.rows.every((row) => row.steps.every((step) => step.active))).toBe(true);
  });

  it('is reproducible for the same seed', () => {
    const pattern = createDrumPattern();
    const first = sparseFill(pattern, { seed: 99, density: 0.3 });
    const second = sparseFill(pattern, { seed: 99, density: 0.3 });
    expect(second).toEqual(first);
    expect(sparseFill(pattern, { seed: 100, density: 0.3 })).not.toEqual(first);
  });

  it('resets velocities of newly activated cells by default', () => {
    let pattern = createDrumPattern(8);
    pattern = withStep(pattern, 0, 0, { velocity: 30 });
    const filled = sparseFill(pattern, { seed: 1, density: 1 });
    expect(filled.rows[0].steps[0].velocity).toBe(DEFAULT_STEP_VELOCITY);
    const kept = sparseFill(pattern, { seed: 1, density: 1, resetVelocity: false });
    expect(kept.rows[0].steps[0].velocity).toBe(30);
  });

  it('preserves gates and offsets', () => {
    let pattern = createDrumPattern(8);
    pattern = withStep(pattern, 1, 3, { gate: 0.9, offset: 0.25 });
    const filled = sparseFill(pattern, { seed: 4, density: 1 });
    expect(filled.rows[1].steps[3].gate).toBe(0.9);
    expect(filled.rows[1].steps[3].offset).toBe(0.25);
  });
});
