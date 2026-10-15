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
