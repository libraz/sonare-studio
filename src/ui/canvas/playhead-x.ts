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
