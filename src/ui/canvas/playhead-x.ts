import type { TimelineRange } from './timeline-range';

/**
 * Playhead line column: the live PPQ column, capped at the follow anchor while
 * following. Before the playhead reaches the anchor the line moves normally
 * from its real position; once it reaches the anchor the cap pins it there
 * while the content scrolls under it.
 *
 * @param view - Timeline viewport mapping PPQ to local x.
 * @param ppq - Playhead position in PPQ.
 * @param anchorX - Fixed local column while following, or null when not following.
 * @returns Local x of the playhead line in px.
 */
export function playheadX(
  view: Pick<TimelineRange, 'ppqToX'>,
  ppq: number,
  anchorX: number | null,
): number {
  const raw = view.ppqToX(ppq);
  return anchorX === null ? raw : Math.min(raw, anchorX);
}

/** Draws the 1.5 px playhead line at local `x` when it lies inside the `widthPx` × `heightPx` canvas. */
export function drawPlayheadLine(
  ctx: CanvasRenderingContext2D,
  x: number,
  widthPx: number,
  heightPx: number,
  color: string,
): void {
  if (x < 0 || x > widthPx) return;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), 0, 1.5, heightPx);
}
