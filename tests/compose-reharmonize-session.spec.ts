import { describe, expect, it } from 'vitest';
import type { LockedRegion } from '@/compose/reharmonize-reactive';
import {
  changedNotesSpan,
  type HarmonicNoteSnapshot,
  isRegionLocked,
  snapshotNotes,
  toggleLockRegion,
} from '@/compose/reharmonize-session';

/** Builds a harmonic note snapshot with a default velocity-free shape. */
function note(
  id: number,
  pitch: number,
  startPpq: number,
  durationPpq: number,
): HarmonicNoteSnapshot {
  return { id, pitch, startPpq, durationPpq };
}

describe('snapshotNotes', () => {
  it('copies only the harmonically relevant fields', () => {
    const notes = [{ id: 1, pitch: 60, startPpq: 0, durationPpq: 2, velocity: 90 }];
    expect(snapshotNotes(notes)).toEqual([{ id: 1, pitch: 60, startPpq: 0, durationPpq: 2 }]);
  });
});

describe('changedNotesSpan', () => {
  it('reports no span when nothing harmonic changed', () => {
    const notes = [note(1, 60, 0, 2), note(2, 64, 2, 2)];
    expect(changedNotesSpan(notes, notes)).toBeNull();
  });

  it('spans an added note', () => {
    const prev = [note(1, 60, 0, 2)];
    const next = [note(1, 60, 0, 2), note(2, 67, 4, 2)];
    expect(changedNotesSpan(prev, next)).toEqual({ startPpq: 4, endPpq: 6 });
  });

  it('spans a removed note', () => {
    const prev = [note(1, 60, 0, 2), note(2, 67, 4, 2)];
    const next = [note(1, 60, 0, 2)];
    expect(changedNotesSpan(prev, next)).toEqual({ startPpq: 4, endPpq: 6 });
  });

  it('covers both the old and new extent of a moved note', () => {
    const prev = [note(1, 60, 0, 2)];
    const next = [note(1, 60, 8, 2)];
    expect(changedNotesSpan(prev, next)).toEqual({ startPpq: 0, endPpq: 10 });
  });

  it('spans a pitch-only change at the note position', () => {
    const prev = [note(1, 60, 4, 2)];
    const next = [note(1, 72, 4, 2)];
    expect(changedNotesSpan(prev, next)).toEqual({ startPpq: 4, endPpq: 6 });
  });

  it('ignores fields outside the harmonic snapshot', () => {
    // Velocity is not part of the snapshot, so a velocity-only edit yields
    // identical snapshots and reports no span.
    const prev = [note(1, 60, 0, 2)];
    const next = [note(1, 60, 0, 2)];
    expect(changedNotesSpan(prev, next)).toBeNull();
  });
});

describe('lock regions', () => {
  const region: LockedRegion = { startPpq: 4, endPpq: 8 };

  it('detects overlap independent of touching edges', () => {
    expect(isRegionLocked([{ startPpq: 4, endPpq: 8 }], region)).toBe(true);
    expect(isRegionLocked([{ startPpq: 6, endPpq: 10 }], region)).toBe(true);
    // Edge-touching spans do not overlap.
    expect(isRegionLocked([{ startPpq: 0, endPpq: 4 }], region)).toBe(false);
    expect(isRegionLocked([{ startPpq: 8, endPpq: 12 }], region)).toBe(false);
    expect(isRegionLocked([], region)).toBe(false);
  });

  it('adds a lock when the region is free, keeping the array sorted', () => {
    const locks = toggleLockRegion([{ startPpq: 12, endPpq: 16 }], region);
    expect(locks).toEqual([
      { startPpq: 4, endPpq: 8 },
      { startPpq: 12, endPpq: 16 },
    ]);
  });

  it('removes every overlapping lock when the region is already locked', () => {
    const locks = toggleLockRegion(
      [
        { startPpq: 4, endPpq: 8 },
        { startPpq: 12, endPpq: 16 },
      ],
      region,
    );
    expect(locks).toEqual([{ startPpq: 12, endPpq: 16 }]);
  });

  it('does not mutate the input array', () => {
    const input: LockedRegion[] = [{ startPpq: 12, endPpq: 16 }];
    toggleLockRegion(input, region);
    expect(input).toEqual([{ startPpq: 12, endPpq: 16 }]);
  });
});
