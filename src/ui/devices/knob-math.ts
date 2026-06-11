/**
 * Pure drag/value math for the quick-control knobs.
 */

/** Vertical drag distance (px) that sweeps a knob across its full range. */
export const KNOB_DRAG_RANGE_PX = 150;

/** Drag scale factor while the fine-adjust modifier (Shift) is held. */
export const KNOB_FINE_SCALE = 0.1;

/** Rotation of the knob indicator at range extremes, in degrees. */
export const KNOB_ROTATION_MAX_DEG = 135;

/**
 * Maps a vertical pointer drag onto a knob value: dragging up increases,
 * a full {@link KNOB_DRAG_RANGE_PX} sweep covers the whole range.
 *
 * @param startValue Value at drag start.
 * @param deltaY Pointer y displacement since drag start (down positive).
 * @param min Range lower bound.
 * @param max Range upper bound.
 * @param fine Fine-adjust modifier held (scales the sweep by 0.1).
 * @returns The new value, clamped to [min, max].
 */
export function knobValueForDrag(
  startValue: number,
  deltaY: number,
  min: number,
  max: number,
  fine = false,
): number {
  const scale = fine ? KNOB_FINE_SCALE : 1;
  const value = startValue + (-deltaY / KNOB_DRAG_RANGE_PX) * (max - min) * scale;
  return Math.min(max, Math.max(min, value));
}

/** Normalized position of a value within its range, in [0, 1]. */
export function controlPercent(value: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** Indicator rotation for a value, in degrees (-135 at min, +135 at max). */
export function knobRotationDeg(value: number, min: number, max: number): number {
  return (controlPercent(value, min, max) * 2 - 1) * KNOB_ROTATION_MAX_DEG;
}

/**
 * Formats a control value for its readout label: large magnitudes drop
 * decimals, small ones keep up to two, and the unit (when given) is appended
 * with a thin separator.
 *
 * @param value Control value.
 * @param unit Display unit, if any.
 * @returns The formatted readout.
 */
export function formatControlValue(value: number, unit?: string): string {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  let text: string;
  if (magnitude >= 1000) text = String(Math.round(value));
  else if (magnitude >= 100) text = value.toFixed(1).replace(/\.0$/, '');
  else text = value.toFixed(2).replace(/\.?0+$/, '') || '0';
  return unit ? `${text} ${unit}` : text;
}
