/**
 * Wheel and button zoom/pan for the piano-roll viewport: ⌘/ctrl-wheel zooms
 * around the pointer, shift-wheel pans horizontally, a plain wheel pans both
 * axes, and the toolbar buttons zoom horizontally around the viewport center or
 * vertically while keeping the center pitch fixed.
 *
 * Every range mutation routes through the injected {@link bump} so the canvases
 * redraw; the row-height zoom is clamped to keep rows legible.
 */

import type { Ref } from 'vue';
import { clamp } from '@/lib/math';
import type { TimelineRange } from '@/ui/canvas/timeline-range';

/** Wheel-to-zoom sensitivity for ⌘wheel / pinch gestures. */
const ZOOM_WHEEL_SENSITIVITY = 0.0035;
/** Per-click zoom multiplier for the toolbar zoom buttons. */
export const ZOOM_BUTTON_STEP = 1.2;
/** Row-height bounds for vertical zoom (px). */
export const MIN_ROW_HEIGHT = 5;
export const MAX_ROW_HEIGHT = 40;

/** Zoom/pan handlers returned by {@link usePianoRollZoom}. */
export interface PianoRollZoom {
  /** Wheel handler: zoom around the pointer or pan, per modifier keys. */
  onWheel(event: WheelEvent): void;
  /** Zooms the timeline horizontally around the viewport center. */
  zoomHorizontal(factor: number): void;
  /** Zooms the pitch rows vertically, keeping the viewport center pitch in place. */
  zoomVertical(factor: number): void;
}

/** Configuration for {@link usePianoRollZoom}. */
export interface UsePianoRollZoomOptions {
  /** Shared timeline viewport mutated by the gestures. */
  range: TimelineRange;
  /** Note-grid cell element (wheel-zoom anchor and size source). */
  gridCell: Ref<HTMLElement | null>;
  /** Bumps the redraw revision after a range mutation. */
  bump(): void;
}

/**
 * Creates the wheel and button zoom/pan handlers for one piano-roll editor.
 *
 * @param options - Shared range, the grid-cell anchor and the redraw bump.
 * @returns Wheel and zoom-button handlers.
 */
export function usePianoRollZoom(options: UsePianoRollZoomOptions): PianoRollZoom {
  const { range, gridCell, bump } = options;

  function onWheel(event: WheelEvent): void {
    const anchorEl = gridCell.value;
    if (!anchorEl) return;
    if (event.metaKey || event.ctrlKey) {
      const anchorX = event.clientX - anchorEl.getBoundingClientRect().left;
      range.zoomAt(anchorX, Math.exp(-event.deltaY * ZOOM_WHEEL_SENSITIVITY));
    } else if (event.shiftKey) {
      range.scrollByPx(event.deltaY + event.deltaX);
    } else {
      range.scrollByPx(event.deltaX);
      range.scrollByY(event.deltaY);
    }
    bump();
  }

  function zoomHorizontal(factor: number): void {
    range.zoomAt(range.widthPx / 2, factor);
    bump();
  }

  function zoomVertical(factor: number): void {
    const centerRow = (range.scrollY + range.heightPx / 2) / range.rowHeight;
    const next = clamp(range.rowHeight * factor, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT);
    range.setRowHeight(next);
    range.setScrollY(centerRow * range.rowHeight - range.heightPx / 2);
    bump();
  }

  return { onWheel, zoomHorizontal, zoomVertical };
}
