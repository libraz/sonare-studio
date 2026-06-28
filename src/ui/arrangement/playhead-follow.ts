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

/** Default follow window: keep the playhead between 12% and 82% of the view. */
export const DEFAULT_PLAYHEAD_FOLLOW_MARGINS: PlayheadFollowMargins = {
  left: 0.12,
  right: 0.82,
};

/**
 * Returns the viewport start that would keep the playhead inside the follow
 * window, or null when no scroll is needed.
 */
export function nextPlayheadFollowStart(
  range: Pick<TimelineRange, 'startPpq' | 'widthPx' | 'pxPerPpq' | 'ppqToX'>,
  playheadPpq: number,
  margins: PlayheadFollowMargins = DEFAULT_PLAYHEAD_FOLLOW_MARGINS,
): number | null {
  if (
    !Number.isFinite(playheadPpq) ||
    range.widthPx <= 0 ||
    range.pxPerPpq <= 0 ||
    margins.left < 0 ||
    margins.right <= margins.left ||
    margins.right > 1
  ) {
    return null;
  }

  const x = range.ppqToX(playheadPpq);
  const leftPx = range.widthPx * margins.left;
  if (x < leftPx) {
    const start = Math.max(0, playheadPpq - leftPx / range.pxPerPpq);
    return start === range.startPpq ? null : start;
  }

  const rightPx = range.widthPx * margins.right;
  if (x > rightPx) {
    const start = Math.max(0, playheadPpq - rightPx / range.pxPerPpq);
    return start === range.startPpq ? null : start;
  }

  return null;
}
