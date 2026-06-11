/**
 * Euclidean rhythm generation (Bjorklund's algorithm).
 *
 * Distributes a number of pulses as evenly as possible over a number of
 * steps. The result is deterministic and starts with a pulse whenever
 * pulses > 0 and rotation = 0, matching the canonical E(k, n) notation:
 * E(3, 8) = [x..x..x.], E(5, 8) = [x.xx.xx.].
 */

/**
 * Generates a euclidean onset pattern.
 *
 * @param pulses Number of onsets (integer, 0..steps).
 * @param steps Total steps (integer, >= 1).
 * @param rotation Steps to rotate the result toward later positions
 *   (positive = onsets move right, wrapping; any integer accepted).
 * @returns One boolean per step; true = onset.
 */
export function euclideanRhythm(pulses: number, steps: number, rotation = 0): boolean[] {
  if (!Number.isInteger(steps) || steps < 1) {
    throw new RangeError(`Euclidean steps must be an integer >= 1, got ${steps}`);
  }
  if (!Number.isInteger(pulses) || pulses < 0 || pulses > steps) {
    throw new RangeError(`Euclidean pulses must be an integer in [0, ${steps}], got ${pulses}`);
  }
  if (!Number.isInteger(rotation)) {
    throw new RangeError(`Euclidean rotation must be an integer, got ${rotation}`);
  }
  const base = bjorklund(pulses, steps);
  const shift = ((rotation % steps) + steps) % steps;
  if (shift === 0) return base;
  return base.map((_, i) => base[(i - shift + steps) % steps]);
}

/** Core Bjorklund pairing: repeatedly folds the remainder into the head groups. */
function bjorklund(pulses: number, steps: number): boolean[] {
  if (pulses === 0) return Array.from({ length: steps }, () => false);
  let head: boolean[][] = Array.from({ length: pulses }, () => [true]);
  let remainder: boolean[][] = Array.from({ length: steps - pulses }, () => [false]);
  while (remainder.length > 1) {
    const count = Math.min(head.length, remainder.length);
    const next: boolean[][] = [];
    for (let i = 0; i < count; i++) next.push([...head[i], ...remainder[i]]);
    remainder = head.length > count ? head.slice(count) : remainder.slice(count);
    head = next;
  }
  return [...head.flat(), ...remainder.flat()];
}
