/**
 * Bounds for moving and resizing notes in the editable source window. A note
 * that straddles a window edge is never pulled toward the inside: the clamp
 * only ever shortens a requested step, so no note moves against its direction.
 */

/** Smallest note length a resize may produce. */
const MIN_RESIZE_PPQ = 0.0625;

/** A note's horizontal extent. */
export interface NoteSpan {
  startPpq: number;
  durationPpq: number;
}

/**
 * Clamps a requested start delta for a group of notes toward zero.
 *
 * Notes starting inside the window bound the leftward step so they stay in it;
 * notes straddling the left edge only bound it at position 0. The rightward
 * step stops at `maxPpq`, and a group already past it does not move right.
 *
 * @param requested - Signed step in PPQ.
 * @param notes - Notes that move together.
 * @param minPpq - Left edge of the editable window.
 * @param maxPpq - Right limit for note ends (may be infinite).
 */
export function clampMoveDelta(
  requested: number,
  notes: ReadonlyArray<NoteSpan>,
  minPpq: number,
  maxPpq: number,
): number {
  if (notes.length === 0 || requested === 0) return 0;
  if (requested < 0) {
    const floor = Math.min(0, -Math.min(...notes.map((note) => note.startPpq)));
    const inside = notes.filter((note) => note.startPpq >= minPpq);
    const lower =
      inside.length > 0
        ? Math.max(floor, minPpq - Math.min(...inside.map((note) => note.startPpq)))
        : floor;
    return Math.max(requested, Math.min(0, lower));
  }
  const upper = maxPpq - Math.max(...notes.map((note) => note.startPpq + note.durationPpq));
  return Math.min(requested, Math.max(0, upper));
}

/**
 * Resizes a note's length by `delta` within `maxPpq`, never in the opposite
 * direction: a note already overhanging the limit keeps its length when asked
 * to grow.
 */
export function clampResizedDuration(note: NoteSpan, delta: number, maxPpq: number): number {
  if (delta > 0) {
    return Math.max(note.durationPpq, Math.min(maxPpq - note.startPpq, note.durationPpq + delta));
  }
  return Math.max(Math.min(note.durationPpq, MIN_RESIZE_PPQ), note.durationPpq + delta);
}
