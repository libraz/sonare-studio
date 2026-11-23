/** Clamps `value` into [min, max]; NaN passes through unchanged. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamps `value` into [0, 1]; NaN passes through unchanged. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Rounds and clamps `value` into [min, max]; a non-finite value yields `fallback`. */
export function clampInt(value: number, min: number, max: number, fallback = min): number {
  return Number.isFinite(value) ? clamp(Math.round(value), min, max) : fallback;
}

/** True for a number that is neither NaN nor infinite. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Smallest value, like spreading into `Math.min` but without the argument-count limit; empty yields Infinity. */
export function minOf(values: Iterable<number>): number {
  let result = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (Number.isNaN(value)) return Number.NaN;
    if (value < result || (value === 0 && result === 0 && Object.is(value, -0))) result = value;
  }
  return result;
}

/** Largest value, like spreading into `Math.max` but without the argument-count limit; empty yields -Infinity. */
export function maxOf(values: Iterable<number>): number {
  let result = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (Number.isNaN(value)) return Number.NaN;
    if (value > result || (value === 0 && result === 0 && Object.is(result, -0))) result = value;
  }
  return result;
}
