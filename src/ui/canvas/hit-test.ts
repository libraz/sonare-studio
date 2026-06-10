/**
 * Hit-testing for note rectangles on canvas note surfaces (piano roll, drum grid).
 * Operates purely on geometry; rendering and input handling live elsewhere.
 */

/** A note's musical extent, used to derive its on-screen rectangle. */
export interface NoteRect {
  /** Stable note identifier. */
  id: string;
  /** Note start in PPQ (quarter note = 1.0). */
  startPpq: number;
  /** Note duration in PPQ. */
  durationPpq: number;
  /** MIDI pitch (0..127). */
  pitch: number;
}

/**
 * Minimal view contract needed to project notes into px space.
 * `TimelineRange` satisfies this structurally.
 */
export interface NoteView {
  /** Converts a PPQ position to a viewport x coordinate in px. */
  ppqToX(ppq: number): number;
  /** Converts a MIDI pitch to the top y coordinate of its row in px. */
  pitchToY(pitch: number): number;
  /** Height of one pitch row in px. */
  readonly rowHeight: number;
}

/** Region of a note rectangle a point falls in. */
export type NoteHitZone = 'body' | 'resize-start' | 'resize-end';

/** Result of a successful point hit-test. */
export interface NoteHit {
  /** Id of the hit note. */
  id: string;
  /** Which interaction zone of the note was hit. */
  zone: NoteHitZone;
}

/** A point in viewport px coordinates. */
export interface Point {
  x: number;
  y: number;
}

/**
 * A marquee rectangle in viewport px coordinates.
 * Negative width/height (dragging up or left) are normalized internally.
 */
export interface MarqueeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Default px distance from a note edge that still counts as a resize zone. */
export const DEFAULT_RESIZE_TOLERANCE_PX = 4;

/** Options for {@link hitTestNote}. */
export interface HitTestOptions {
  /** Px distance from a note edge treated as a resize handle. Default {@link DEFAULT_RESIZE_TOLERANCE_PX}. */
  resizeTolerancePx?: number;
}

/**
 * Finds the note under a point and the interaction zone hit.
 *
 * Notes are assumed to be drawn in array order, so when several notes overlap
 * the last matching note in the array (topmost) wins. A point hits a note when
 * `x` is in [left, right) and `y` is in [top, top + rowHeight). Within a hit,
 * `x` within the tolerance of the left/right edge yields 'resize-start' /
 * 'resize-end'; if the note is narrower than twice the tolerance the halves
 * split at the horizontal center so both handles stay reachable.
 *
 * @param notes - Candidate notes in draw order (bottom to top).
 * @param point - Point in viewport px coordinates.
 * @param view - Projection from musical coordinates to px.
 * @param options - Tolerance configuration.
 * @returns The topmost hit and its zone, or null when nothing is hit.
 */
export function hitTestNote(
  notes: readonly NoteRect[],
  point: Point,
  view: NoteView,
  options: HitTestOptions = {},
): NoteHit | null {
  const tolerance = options.resizeTolerancePx ?? DEFAULT_RESIZE_TOLERANCE_PX;
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i];
    const top = view.pitchToY(note.pitch);
    if (point.y < top || point.y >= top + view.rowHeight) continue;
    const left = view.ppqToX(note.startPpq);
    const right = view.ppqToX(note.startPpq + note.durationPpq);
    if (point.x < left || point.x >= right) continue;
    return { id: note.id, zone: resolveZone(point.x, left, right, tolerance) };
  }
  return null;
}

/**
 * Returns the ids of all notes whose rectangles overlap a marquee rectangle.
 *
 * Overlap must have positive area: rectangles that merely touch along an edge
 * are not selected, and a zero-width or zero-height marquee selects nothing.
 * The marquee is normalized first, so negative width/height from dragging up
 * or left are handled.
 *
 * @param notes - Candidate notes.
 * @param marquee - Marquee rectangle in viewport px coordinates.
 * @param view - Projection from musical coordinates to px.
 * @returns Ids of intersecting notes in input order.
 */
export function marqueeSelect(
  notes: readonly NoteRect[],
  marquee: MarqueeRect,
  view: NoteView,
): string[] {
  const mLeft = Math.min(marquee.x, marquee.x + marquee.width);
  const mRight = Math.max(marquee.x, marquee.x + marquee.width);
  const mTop = Math.min(marquee.y, marquee.y + marquee.height);
  const mBottom = Math.max(marquee.y, marquee.y + marquee.height);
  // A degenerate marquee (no drag) selects nothing; clicks use hitTestNote.
  if (mLeft === mRight || mTop === mBottom) return [];
  const selected: string[] = [];
  for (const note of notes) {
    const left = view.ppqToX(note.startPpq);
    const right = view.ppqToX(note.startPpq + note.durationPpq);
    const top = view.pitchToY(note.pitch);
    const bottom = top + view.rowHeight;
    if (left < mRight && right > mLeft && top < mBottom && bottom > mTop) {
      selected.push(note.id);
    }
  }
  return selected;
}

/**
 * Resolves the interaction zone for an x position inside a note rectangle.
 */
function resolveZone(x: number, left: number, right: number, tolerance: number): NoteHitZone {
  const width = right - left;
  if (width <= tolerance * 2) {
    return x < left + width / 2 ? 'resize-start' : 'resize-end';
  }
  if (x - left <= tolerance) return 'resize-start';
  if (right - x <= tolerance) return 'resize-end';
  return 'body';
}
