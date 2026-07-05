/**
 * Playhead overlay layer for the arrangement canvas: a thin vertical line drawn
 * on a dedicated canvas so playhead motion never repaints the clips. A
 * requestAnimationFrame loop polls the transport position and schedules an
 * overlay repaint only when the playhead's pixel column changed.
 *
 * The composable owns the RAF loop's lifecycle (started on mount, cancelled on
 * unmount) so there is exactly one frame loop and no leak.
 */

import { onBeforeUnmount, onMounted, type Ref } from 'vue';
import type { ARRANGEMENT_COLORS } from '@/components/arrangement/theme';
import { getCanvasContext } from '@/components/piano-roll/theme';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';

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

  /**
   * Line column: the live PPQ column, capped at the follow anchor while
   * following. Before the playhead reaches the anchor (e.g. right after playback
   * starts left of it) the line moves normally from its real position; once it
   * reaches the anchor the cap pins it there while the content scrolls under it.
   */
  function playheadX(view: TimelineRange, getter: () => number): number {
    const raw = view.ppqToX(getter());
    const anchor = anchoredLocalX?.() ?? null;
    return anchor === null ? raw : Math.min(raw, anchor);
  }

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
    if (getter) {
      const x = playheadX(view, getter);
      if (x >= 0 && x <= w) {
        ctx.fillStyle = colors.playhead;
        ctx.fillRect(Math.round(x), 0, 1.5, h);
      }
    }
  }

  function scheduleOverlay(): void {
    painter.schedule(`arrangement-overlay-${layerId}`, drawOverlay);
  }

  // Playhead polling: redraw the overlay only when the playhead px moved.
  let playheadRaf: number | null = null;
  let lastPlayheadX = Number.NaN;

  function playheadTick(): void {
    const getter = positionPpq();
    if (getter) {
      // Redraw only when the line's column actually moved; once pinned at the
      // anchor this stays put until the position or anchor state changes.
      const x = playheadX(range(), getter);
      if (x !== lastPlayheadX) {
        lastPlayheadX = x;
        scheduleOverlay();
      }
    }
    playheadRaf = requestAnimationFrame(playheadTick);
  }

  onMounted(() => {
    playheadRaf = requestAnimationFrame(playheadTick);
  });

  onBeforeUnmount(() => {
    if (playheadRaf !== null) cancelAnimationFrame(playheadRaf);
    playheadRaf = null;
  });

  return { drawOverlay, scheduleOverlay };
}
