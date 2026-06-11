import type { EditorNote } from '@/project/types';

/**
 * Memoized horizontal content extent of the note list.
 *
 * The store replaces the note mirror wholesale on every command, so the array
 * identity is a reliable cache key: between edits (e.g. during wheel-driven
 * pan/zoom, which recomputes the scrollbar thumb on every revision bump) the
 * notes need not be re-scanned.
 */

/** Returns the largest note end (startPpq + durationPpq) or 0 when empty. */
export function maxNoteEndPpq(notes: readonly EditorNote[]): number {
  let maxEnd = 0;
  for (const note of notes) {
    const end = note.startPpq + note.durationPpq;
    if (end > maxEnd) maxEnd = end;
  }
  return maxEnd;
}

/**
 * Creates a single-entry cache over {@link maxNoteEndPpq} keyed by the note
 * array identity.
 *
 * @param compute Extent function (injectable for tests).
 * @returns Getter returning the cached extent for the given array.
 */
export function createNoteExtentCache(
  compute: (notes: readonly EditorNote[]) => number = maxNoteEndPpq,
): (notes: readonly EditorNote[]) => number {
  let cachedNotes: readonly EditorNote[] | null = null;
  let cachedExtent = 0;
  return (notes) => {
    if (notes !== cachedNotes) {
      cachedNotes = notes;
      cachedExtent = compute(notes);
    }
    return cachedExtent;
  };
}
