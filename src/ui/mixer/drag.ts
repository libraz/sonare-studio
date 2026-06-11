/**
 * Pointer-drag and keyboard-nudge math shared by the mixer knob and fader.
 *
 * Knob drags are relative: each pointermove converts its pixel delta into a
 * value delta over the control range, scaled down in fine mode (shift held),
 * and the caller accumulates from the previous value. This keeps fine mode
 * correct even when shift is pressed or released mid-drag.
 */

/** Value bounds of a draggable control. */
export interface DragRange {
  /** Lower bound (inclusive). */
  min: number;
  /** Upper bound (inclusive). */
  max: number;
}

/** Vertical pixel travel that sweeps the full control range. */
export const DEFAULT_DRAG_PIXELS = 150;

/** Drag/nudge scale factor while fine mode (shift) is held. */
export const FINE_FACTOR = 0.2;

/** Number of coarse keyboard steps across the full range. */
export const NUDGE_DIVISIONS = 50;

/** Options for {@link applyDrag} and {@link nudgeValue}. */
export interface DragOptions {
  /** Pixel travel for the full range (default {@link DEFAULT_DRAG_PIXELS}). */
  pixels?: number;
  /** Fine mode: scales the delta by {@link FINE_FACTOR}. */
  fine?: boolean;
}

/** Clamps a value into a range. */
export function clampToRange(value: number, range: DragRange): number {
  return Math.min(range.max, Math.max(range.min, value));
}

/**
 * Converts a pixel delta into a value delta over a control range.
 *
 * @param deltaPxUp Pixels moved, positive = upward (value increases).
 * @param range Control bounds.
 * @param options Pixel travel and fine mode.
 * @returns The (unclamped) value delta.
 */
export function dragDeltaValue(
  deltaPxUp: number,
  range: DragRange,
  options: DragOptions = {},
): number {
  const pixels = options.pixels ?? DEFAULT_DRAG_PIXELS;
  const factor = options.fine ? FINE_FACTOR : 1;
  return (deltaPxUp / pixels) * (range.max - range.min) * factor;
}

/**
 * Applies a pixel delta to a value, clamped to the control range.
 *
 * @param value Value before this move.
 * @param deltaPxUp Pixels moved, positive = upward.
 * @param range Control bounds.
 * @param options Pixel travel and fine mode.
 * @returns The new clamped value.
 */
export function applyDrag(
  value: number,
  deltaPxUp: number,
  range: DragRange,
  options: DragOptions = {},
): number {
  return clampToRange(value + dragDeltaValue(deltaPxUp, range, options), range);
}

/**
 * Returns the keyboard nudge step for a control range.
 *
 * @param range Control bounds.
 * @param fine Fine mode: scales the step by {@link FINE_FACTOR}.
 */
export function nudgeStep(range: DragRange, fine = false): number {
  const step = (range.max - range.min) / NUDGE_DIVISIONS;
  return fine ? step * FINE_FACTOR : step;
}

/**
 * Nudges a value by one keyboard step, clamped to the control range.
 *
 * @param value Current value.
 * @param range Control bounds.
 * @param direction +1 to increase, -1 to decrease.
 * @param fine Fine mode: smaller step.
 * @returns The new clamped value.
 */
export function nudgeValue(
  value: number,
  range: DragRange,
  direction: 1 | -1,
  fine = false,
): number {
  return clampToRange(value + direction * nudgeStep(range, fine), range);
}
