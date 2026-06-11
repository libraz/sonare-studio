/**
 * Deterministic pseudo-random number generation for the step sequencer.
 *
 * All randomized pattern operations (velocity jitter, sparse fill) take an
 * explicit numeric seed and run through mulberry32 so results are exactly
 * reproducible; Math.random is never used.
 */

/**
 * Creates a mulberry32 generator.
 *
 * @param seed Any finite number; only its lower 32 bits matter.
 * @returns A function yielding floats in [0, 1), deterministic for the seed.
 */
export function mulberry32(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
