/** Minimal note shape needed for viewport culling. */
export interface VisibleNoteLike {
  startPpq: number;
  durationPpq: number;
  pitch: number;
}

/** Visible musical window of a note-grid viewport, for culling. */
export interface NoteViewWindow {
  /** Left edge of the viewport in PPQ. */
  startPpq: number;
  /** Exclusive right edge of the viewport in PPQ. */
  endPpq: number;
  /** Lowest (at least partially) visible pitch row. */
  minPitch: number;
  /** Highest (at least partially) visible pitch row. */
  maxPitch: number;
}

interface IndexedNote<T extends VisibleNoteLike> {
  note: T;
  index: number;
  maxEndBeforeOrAt: number;
}

/**
 * Cached start-sorted note index for one immutable note array.
 *
 * Store note mirrors are replaced on edit, so array identity is a practical
 * invalidation key. The prefix max-end lets a viewport skip early notes that
 * end before the visible window, while preserving long notes that started off
 * screen and continue into view.
 */
interface VisibleNoteIndex<T extends VisibleNoteLike> {
  source: readonly T[];
  byStart: IndexedNote<T>[];
}

const cachedIndexes = new WeakMap<readonly VisibleNoteLike[], VisibleNoteIndex<VisibleNoteLike>>();

function buildIndex<T extends VisibleNoteLike>(notes: readonly T[]): VisibleNoteIndex<T> {
  let maxEndBeforeOrAt = Number.NEGATIVE_INFINITY;
  const byStart = notes
    .map((note, index) => ({ note, index, maxEndBeforeOrAt }))
    .sort((a, b) => a.note.startPpq - b.note.startPpq || a.index - b.index);

  for (const entry of byStart) {
    maxEndBeforeOrAt = Math.max(maxEndBeforeOrAt, entry.note.startPpq + entry.note.durationPpq);
    entry.maxEndBeforeOrAt = maxEndBeforeOrAt;
  }

  return { source: notes, byStart };
}

function indexFor<T extends VisibleNoteLike>(notes: readonly T[]): VisibleNoteIndex<T> {
  let cachedIndex = cachedIndexes.get(notes);
  if (!cachedIndex) {
    cachedIndex = buildIndex(notes);
    cachedIndexes.set(notes, cachedIndex);
  }
  return cachedIndex as VisibleNoteIndex<T>;
}

function firstPotentialOverlap<T extends VisibleNoteLike>(
  byStart: readonly IndexedNote<T>[],
  startPpq: number,
): number {
  let lo = 0;
  let hi = byStart.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (byStart[mid].maxEndBeforeOrAt > startPpq) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function firstStartAtOrAfter<T extends VisibleNoteLike>(
  byStart: readonly IndexedNote<T>[],
  endPpq: number,
): number {
  let lo = 0;
  let hi = byStart.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (byStart[mid].note.startPpq >= endPpq) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Returns notes intersecting the visible window, in original draw order.
 *
 * This avoids scanning every note during scroll/playback while keeping canvas
 * layering stable for overlapping notes.
 */
export function visibleNotesInWindow<T extends VisibleNoteLike>(
  notes: readonly T[],
  view: NoteViewWindow,
): T[] {
  if (notes.length === 0 || view.endPpq <= view.startPpq || view.maxPitch < view.minPitch) {
    return [];
  }

  const { byStart } = indexFor(notes);
  const from = firstPotentialOverlap(byStart, view.startPpq);
  const to = firstStartAtOrAfter(byStart, view.endPpq);
  const visible: IndexedNote<T>[] = [];

  for (let i = from; i < to; i++) {
    const entry = byStart[i];
    const note = entry.note;
    if (
      note.startPpq + note.durationPpq > view.startPpq &&
      note.pitch >= view.minPitch &&
      note.pitch <= view.maxPitch
    ) {
      visible.push(entry);
    }
  }

  visible.sort((a, b) => a.index - b.index);
  return visible.map((entry) => entry.note);
}
