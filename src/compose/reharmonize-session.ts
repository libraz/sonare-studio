/**
 * Session-side helpers for reactive reharmonization: the note-snapshot diff
 * that turns "the composer stopped editing" into the edited PPQ span the
 * proposal pass stabilizes around, and the lock-region reducer backing the
 * chord lock strip. Pure module (no Vue/Pinia) so both are unit-testable.
 */

import type { LockedRegion } from './reharmonize-reactive';

/** The harmonically relevant fields of one note, keyed by its editor id. */
export interface HarmonicNoteSnapshot {
  id: number;
  pitch: number;
  startPpq: number;
  durationPpq: number;
}

/** Captures the harmonically relevant fields of a note list for later diffing. */
export function snapshotNotes(notes: ReadonlyArray<HarmonicNoteSnapshot>): HarmonicNoteSnapshot[] {
  return notes.map((note) => ({
    id: note.id,
    pitch: note.pitch,
    startPpq: note.startPpq,
    durationPpq: note.durationPpq,
  }));
}

/**
 * Diffs two note snapshots and returns the bounding PPQ span of every note the
 * edit touched: added and removed notes, plus notes whose pitch, start or
 * duration changed (a moved note contributes both its old and new extent).
 * Velocity/channel-only edits do not affect harmony and report no span.
 *
 * @param prev The snapshot taken when the previous edit settled.
 * @param next The current note list.
 * @returns The changed bounding span in the notes' own (clip-relative) PPQ
 *   frame, or null when nothing harmonic changed.
 */
export function changedNotesSpan(
  prev: ReadonlyArray<HarmonicNoteSnapshot>,
  next: ReadonlyArray<HarmonicNoteSnapshot>,
): { startPpq: number; endPpq: number } | null {
  const prevById = new Map(prev.map((note) => [note.id, note]));
  const nextIds = new Set(next.map((note) => note.id));
  let startPpq = Number.POSITIVE_INFINITY;
  let endPpq = Number.NEGATIVE_INFINITY;
  const extend = (note: HarmonicNoteSnapshot): void => {
    startPpq = Math.min(startPpq, note.startPpq);
    endPpq = Math.max(endPpq, note.startPpq + note.durationPpq);
  };
  for (const note of next) {
    const before = prevById.get(note.id);
    if (before === undefined) {
      extend(note);
      continue;
    }
    if (
      before.pitch !== note.pitch ||
      before.startPpq !== note.startPpq ||
      before.durationPpq !== note.durationPpq
    ) {
      extend(before);
      extend(note);
    }
  }
  for (const note of prev) {
    if (!nextIds.has(note.id)) extend(note);
  }
  return startPpq <= endPpq ? { startPpq, endPpq } : null;
}

/** Whether a region overlaps any locked span. */
export function isRegionLocked(locks: ReadonlyArray<LockedRegion>, region: LockedRegion): boolean {
  return locks.some((lock) => lock.endPpq > region.startPpq && lock.startPpq < region.endPpq);
}

/**
 * Toggles a lock over a region: when the region overlaps existing locks they
 * are all removed (the click reads as "unlock this"); otherwise the region is
 * added as a new lock. Returns a new sorted array; the input is not mutated.
 */
export function toggleLockRegion(
  locks: ReadonlyArray<LockedRegion>,
  region: LockedRegion,
): LockedRegion[] {
  const kept = locks.filter(
    (lock) => !(lock.endPpq > region.startPpq && lock.startPpq < region.endPpq),
  );
  if (kept.length < locks.length) return kept;
  return [...locks, { startPpq: region.startPpq, endPpq: region.endPpq }].sort(
    (a, b) => a.startPpq - b.startPpq,
  );
}
