/**
 * Horizontal playhead following for the arrangement viewport.
 *
 * The follow window leaves a margin on both sides so normal playback can move
 * through the view, then scrolls just enough to keep the playhead visible.
 */

import type { TimelineRange } from '@/ui/canvas/timeline-range';

/** Fractional viewport margins used while following playback. */
export interface PlayheadFollowMargins {
  /** Left follow boundary as a fraction of viewport width. */
  left: number;
  /** Right follow boundary as a fraction of viewport width. */
  right: number;
}

/** Default follow window: keep the playhead between 12% and 68% of the view. */
export const DEFAULT_PLAYHEAD_FOLLOW_MARGINS: PlayheadFollowMargins = {
  left: 0.12,
  right: 0.68,
};

/**
 * Fixed screen column, in px from the shared timeline area's left edge (i.e.
 * including each view's left gutter), where the playhead is pinned while
 * following playback. Anchoring both the arrangement and the piano-roll
 * playhead to the same absolute column — the arrangement to
 * `ANCHOR - trackHeaderWidth`, the piano roll to `ANCHOR - keyboardWidth` —
 * keeps their red playhead lines vertically aligned even though the two views
 * differ in gutter width, zoom and scroll. Kept just right of the wider gutter
 * so the line sits near the left edge of both timelines.
 */
export const PLAYHEAD_FOLLOW_ANCHOR_X = 360;

/**
 * Returns the viewport start that pins the playhead at a fixed local column
 * (`anchorLocalPx`, measured from the canvas left edge), or null when the
 * viewport is already there. Clamped so the view never scrolls before 0, which
 * lets the playhead drift left of the anchor near the song start.
 */
export function anchoredPlayheadFollowStart(
  range: Pick<TimelineRange, 'startPpq' | 'widthPx' | 'pxPerPpq'>,
  playheadPpq: number,
  anchorLocalPx: number,
): number | null {
  if (!Number.isFinite(playheadPpq) || range.widthPx <= 0 || range.pxPerPpq <= 0) {
    return null;
  }
  const start = Math.max(0, playheadPpq - anchorLocalPx / range.pxPerPpq);
  return start === range.startPpq ? null : start;
}

/**
 * Returns a viewport start that scrolls an off-screen playhead back to the
 * follow anchor column, or null when the playhead is already visible (so a seek
 * that lands inside the current viewport never yanks it). Used on manual seeks
 * while stopped, where nothing else scrolls the view, so the playhead can never
 * stay hidden after the transport jumps outside the visible range.
 */
export function revealPlayheadStart(
  range: Pick<TimelineRange, 'startPpq' | 'widthPx' | 'pxPerPpq' | 'ppqToX'>,
  playheadPpq: number,
  anchorLocalPx: number,
): number | null {
  if (!Number.isFinite(playheadPpq) || range.widthPx <= 0 || range.pxPerPpq <= 0) {
    return null;
  }
  const x = range.ppqToX(playheadPpq);
  if (x >= 0 && x <= range.widthPx) return null;
  return anchoredPlayheadFollowStart(range, playheadPpq, anchorLocalPx);
}

/**
 * Returns the scrollLeft that keeps an item's horizontal bounds inside the
 * follow window, or null when no DOM scroll is needed.
 */
export function nextHorizontalFollowScrollLeft(
  viewportWidthPx: number,
  scrollLeftPx: number,
  itemLeftPx: number,
  itemRightPx: number,
  margins: PlayheadFollowMargins = DEFAULT_PLAYHEAD_FOLLOW_MARGINS,
): number | null {
  if (
    viewportWidthPx <= 0 ||
    !Number.isFinite(scrollLeftPx) ||
    !Number.isFinite(itemLeftPx) ||
    !Number.isFinite(itemRightPx) ||
    margins.left < 0 ||
    margins.right <= margins.left ||
    margins.right > 1
  ) {
    return null;
  }

  const leftBoundary = scrollLeftPx + viewportWidthPx * margins.left;
  if (itemLeftPx < leftBoundary) {
    const next = Math.max(0, itemLeftPx - viewportWidthPx * margins.left);
    return next === scrollLeftPx ? null : next;
  }

  const rightBoundary = scrollLeftPx + viewportWidthPx * margins.right;
  if (itemRightPx > rightBoundary) {
    const next = Math.max(0, itemRightPx - viewportWidthPx * margins.right);
    return next === scrollLeftPx ? null : next;
  }

  return null;
}
