/**
 * Drag and nudge constants shared by the mixer knob and fader.
 *
 * Drags are relative: the caller accumulates each pointermove delta, scaled
 * down in fine mode (shift held), so fine mode stays correct even when shift
 * is pressed or released mid-drag.
 */

import { clamp } from '@/lib/math';

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

/** Clamps a value into a range. */
export function clampToRange(value: number, range: DragRange): number {
  return clamp(value, range.min, range.max);
}
