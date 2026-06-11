import { describe, expect, it, vi } from 'vitest';
import { createNoteExtentCache, maxNoteEndPpq } from '@/components/piano-roll/content-extent';
import type { EditorNote } from '@/project/types';

function note(id: number, startPpq: number, durationPpq: number): EditorNote {
  return { id, pitch: 60, velocity: 100, startPpq, durationPpq, channel: 0 };
}

describe('maxNoteEndPpq', () => {
  it('returns 0 for an empty list', () => {
    expect(maxNoteEndPpq([])).toBe(0);
  });

  it('returns the largest note end regardless of order', () => {
    const notes = [note(1, 8, 2), note(2, 0, 4), note(3, 4, 1)];
    expect(maxNoteEndPpq(notes)).toBe(10);
  });
});

describe('createNoteExtentCache', () => {
  it('computes once per array identity (cache hit on repeat calls)', () => {
    const compute = vi.fn(maxNoteEndPpq);
    const extent = createNoteExtentCache(compute);
    const notes = [note(1, 0, 4), note(2, 6, 2)];

    expect(extent(notes)).toBe(8);
    expect(extent(notes)).toBe(8);
    expect(extent(notes)).toBe(8);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('recomputes when the array identity changes', () => {
    const compute = vi.fn(maxNoteEndPpq);
    const extent = createNoteExtentCache(compute);
    const first = [note(1, 0, 4)];
    const second = [note(1, 0, 4), note(2, 10, 2)];

    expect(extent(first)).toBe(4);
    expect(extent(second)).toBe(12);
    expect(extent(first)).toBe(4);
    expect(compute).toHaveBeenCalledTimes(3);
  });
});
