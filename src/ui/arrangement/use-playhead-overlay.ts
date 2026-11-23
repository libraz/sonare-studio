/**
 * Playhead overlay layer for the arrangement canvas: a thin vertical line drawn
 * on a dedicated canvas so playhead motion never repaints the clips. A
 * requestAnimationFrame loop polls the transport position and schedules an
 * overlay repaint only when the playhead's pixel column changed.
 *
 * The composable owns the RAF loop's lifecycle (started on mount, cancelled on
 * unmount) so there is exactly one frame loop and no leak.
 */

import type { Ref } from 'vue';
import type { ARRANGEMENT_COLORS } from '@/components/arrangement/theme';
import { getCanvasContext } from '@/components/piano-roll/theme';
import type { Painter } from '@/ui/canvas/painter';
import { drawPlayheadLine, playheadX } from '@/ui/canvas/playhead-x';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { usePlayheadPoll } from '@/ui/canvas/use-playhead-poll';

type ArrangementColors = typeof ARRANGEMENT_COLORS;

/** Inputs the playhead overlay reads each frame. */
export interface PlayheadOverlayOptions {
  /** Overlay canvas element to draw on. */
  canvas: Ref<HTMLCanvasElement | null>;
  /** Frame batcher used to coalesce overlay repaints. */
  painter: Painter;
  /** Unique painter layer suffix shared with the base layer. */
  layerId: string;
  /** Returns the current timeline viewport. */
  range: () => TimelineRange;
  /** Returns the playhead position getter in PPQ, or undefined to hide it. */
  positionPpq: () => (() => number) | undefined;
  /**
   * While following playback the playhead is pinned to this fixed local column
   * (px from the canvas left edge) instead of tracking its live PPQ position,
   * so the content scrolls under a stationary line. Returns null when not
   * following, i.e. the line should track the playhead normally.
   */
  anchoredLocalX?: () => number | null;
  /** Color tokens. */
  colors: ArrangementColors;
}

/** Handle exposing the overlay draw and a manual repaint scheduler. */
export interface PlayheadOverlay {
  /** Draws the playhead line across the ruler and lanes. */
  drawOverlay(): void;
  /** Schedules an overlay repaint on the painter. */
  scheduleOverlay(): void;
}

/**
 * Wires up the playhead overlay layer and its frame loop.
 *
 * @param options - Canvas, painter, viewport and position accessors.
 * @returns The overlay draw callback and its repaint scheduler.
 */
export function usePlayheadOverlay(options: PlayheadOverlayOptions): PlayheadOverlay {
  const { canvas, painter, layerId, range, positionPpq, anchoredLocalX, colors } = options;

  function drawOverlay(): void {
    const el = canvas.value;
    if (!el) return;
    const ctx = getCanvasContext(el);
    if (!ctx) return;
    const view = range();
    const w = view.widthPx;
    const h = view.heightPx;
    ctx.clearRect(0, 0, w, h);
    const getter = positionPpq();
    if (getter)
      drawPlayheadLine(
        ctx,
        playheadX(view, getter(), anchoredLocalX?.() ?? null),
        w,
        h,
        colors.playhead,
      );
  }

  function scheduleOverlay(): void {
    painter.schedule(`arrangement-overlay-${layerId}`, drawOverlay);
  }

  // Playhead polling: redraw the overlay only when the playhead px moved.
  usePlayheadPoll(() => {
    const getter = positionPpq();
    return getter ? playheadX(range(), getter(), anchoredLocalX?.() ?? null) : undefined;
  }, scheduleOverlay);

  return { drawOverlay, scheduleOverlay };
}
