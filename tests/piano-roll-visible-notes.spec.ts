import { describe, expect, it } from 'vitest';
import { type VisibleNoteLike, visibleNotesInWindow } from '@/components/piano-roll/visible-notes';

interface TestNote extends VisibleNoteLike {
  id: string;
}

function note(id: string, startPpq: number, durationPpq: number, pitch = 60): TestNote {
  return { id, startPpq, durationPpq, pitch };
}

const view = {
  startPpq: 4,
  endPpq: 8,
  minPitch: 50,
  maxPitch: 70,
};

describe('visibleNotesInWindow', () => {
  it('returns notes intersecting the visible ppq and pitch window', () => {
    const notes = [
      note('before', 1, 3),
      note('left-overlap', 1, 4),
      note('inside', 5, 1),
      note('right-touch', 8, 1),
      note('low', 5, 1, 49),
      note('high', 5, 1, 71),
    ];

    expect(visibleNotesInWindow(notes, view).map((n) => n.id)).toEqual(['left-overlap', 'inside']);
  });

  it('preserves original draw order after indexed lookup', () => {
    const notes = [
      note('drawn-first', 6, 1),
      note('drawn-second', 4.5, 1),
      note('long-from-left', 0, 10),
    ];

    expect(visibleNotesInWindow(notes, view).map((n) => n.id)).toEqual([
      'drawn-first',
      'drawn-second',
      'long-from-left',
    ]);
  });

  it('returns an empty list for invalid or empty windows', () => {
    expect(visibleNotesInWindow([note('a', 1, 1)], { ...view, endPpq: view.startPpq })).toEqual([]);
    expect(visibleNotesInWindow([note('a', 1, 1)], { ...view, maxPitch: 40 })).toEqual([]);
    expect(visibleNotesInWindow([], view)).toEqual([]);
  });
});
