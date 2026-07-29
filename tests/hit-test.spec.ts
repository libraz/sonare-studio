import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESIZE_TOLERANCE_PX,
  hitTestNote,
  marqueeSelect,
  type NoteRect,
  type NoteView,
} from '@/ui/canvas/hit-test';

/**
 * Simple linear view: 100 px per PPQ, no scroll, 10 px rows, pitch 127 at top.
 */
const view: NoteView = {
  ppqToX: (ppq) => ppq * 100,
  pitchToY: (pitch) => (127 - pitch) * 10,
  rowHeight: 10,
};

const note = (id: string, startPpq: number, durationPpq: number, pitch: number): NoteRect => ({
  id,
  startPpq,
  durationPpq,
  pitch,
});

// Note "a": x [100, 300), pitch 60 -> y [670, 680).
const notes: NoteRect[] = [note('a', 1, 2, 60), note('b', 4, 1, 60), note('c', 1, 2, 61)];

describe('hitTestNote', () => {
  it('hits the note body in the middle of the rect', () => {
    expect(hitTestNote(notes, { x: 200, y: 675 }, view)).toEqual({ id: 'a', zone: 'body' });
  });

  it('returns null when nothing is under the point', () => {
    expect(hitTestNote(notes, { x: 350, y: 675 }, view)).toBeNull(); // gap between a and b
    expect(hitTestNote(notes, { x: 200, y: 695 }, view)).toBeNull(); // wrong row
    expect(hitTestNote(notes, { x: 50, y: 675 }, view)).toBeNull(); // before note start
  });

  it('uses default tolerance for resize zones', () => {
    expect(hitTestNote(notes, { x: 100, y: 675 }, view)?.zone).toBe('resize-start');
    expect(hitTestNote(notes, { x: 100 + DEFAULT_RESIZE_TOLERANCE_PX, y: 675 }, view)?.zone).toBe(
      'resize-start',
    );
    expect(
      hitTestNote(notes, { x: 100 + DEFAULT_RESIZE_TOLERANCE_PX + 0.01, y: 675 }, view)?.zone,
    ).toBe('body');
    expect(hitTestNote(notes, { x: 299, y: 675 }, view)?.zone).toBe('resize-end');
  });

  it('respects a custom resize tolerance', () => {
    const opts = { resizeTolerancePx: 10 };
    expect(hitTestNote(notes, { x: 109, y: 675 }, view, opts)?.zone).toBe('resize-start');
    expect(hitTestNote(notes, { x: 111, y: 675 }, view, opts)?.zone).toBe('body');
    expect(hitTestNote(notes, { x: 290, y: 675 }, view, opts)?.zone).toBe('resize-end');
    expect(hitTestNote(notes, { x: 289.9, y: 675 }, view, opts)?.zone).toBe('body');
  });

  it('treats the left edge as inclusive and the right edge as exclusive', () => {
    expect(hitTestNote(notes, { x: 100, y: 675 }, view)).not.toBeNull();
    expect(hitTestNote(notes, { x: 300, y: 675 }, view)).toBeNull();
  });

  it('treats the row top as inclusive and the row bottom as exclusive', () => {
    expect(hitTestNote(notes, { x: 200, y: 670 }, view)?.id).toBe('a');
    // y = 680 belongs to the next row down (pitch 59), where no note exists.
    expect(hitTestNote(notes, { x: 200, y: 680 }, view)).toBeNull();
    // y = 669.999 belongs to pitch 61, hitting note c.
    expect(hitTestNote(notes, { x: 200, y: 669.999 }, view)?.id).toBe('c');
  });

  it('keeps a body zone on a narrow note while both resize handles remain reachable', () => {
    // 0.05 PPQ -> 5 px wide, x [100, 105), tolerance 4 px.
    const narrow = [note('n', 1, 0.05, 60)];
    expect(hitTestNote(narrow, { x: 101, y: 675 }, view)?.zone).toBe('resize-start');
    expect(hitTestNote(narrow, { x: 102.4, y: 675 }, view)?.zone).toBe('body');
    expect(hitTestNote(narrow, { x: 102.5, y: 675 }, view)?.zone).toBe('body');
    expect(hitTestNote(narrow, { x: 104.9, y: 675 }, view)?.zone).toBe('resize-end');
  });

  it('hits the minimum two-pixel width used for an almost zero-duration note', () => {
    const tiny = [note('tiny', 1, 0.001, 60)];
    expect(hitTestNote(tiny, { x: 101.5, y: 675 }, view)).not.toBeNull();
  });

  it('returns the topmost (last drawn) note when notes overlap', () => {
    const overlapping = [note('under', 1, 2, 60), note('over', 1.5, 2, 60)];
    expect(hitTestNote(overlapping, { x: 200, y: 675 }, view)?.id).toBe('over');
    // Only the underlying note covers x < 150.
    expect(hitTestNote(overlapping, { x: 120, y: 675 }, view)?.id).toBe('under');
  });

  it('handles an empty note list', () => {
    expect(hitTestNote([], { x: 0, y: 0 }, view)).toBeNull();
  });
});

describe('marqueeSelect', () => {
  it('selects notes fully contained in the marquee', () => {
    const ids = marqueeSelect(notes, { x: 50, y: 660, width: 500, height: 30 }, view);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('selects notes partially overlapping the marquee', () => {
    // Overlaps only the right part of note a's row.
    const ids = marqueeSelect(notes, { x: 250, y: 672, width: 20, height: 4 }, view);
    expect(ids).toEqual(['a']);
  });

  it('does not select notes that only touch the marquee edge', () => {
    // Marquee right edge exactly at note a's left edge (x = 100).
    expect(marqueeSelect(notes, { x: 0, y: 670, width: 100, height: 10 }, view)).toEqual([]);
    // Marquee bottom exactly at note a's top (y = 670).
    expect(marqueeSelect(notes, { x: 100, y: 600, width: 300, height: 70 }, view)).toEqual(['c']);
  });

  it('does not select zero-area marquees', () => {
    expect(marqueeSelect(notes, { x: 200, y: 675, width: 0, height: 0 }, view)).toEqual([]);
  });

  it('normalizes negative width/height (drag up-left)', () => {
    const forward = marqueeSelect(notes, { x: 150, y: 665, width: 100, height: 20 }, view);
    const backward = marqueeSelect(notes, { x: 250, y: 685, width: -100, height: -20 }, view);
    expect(backward).toEqual(forward);
    expect(backward).toEqual(['a', 'c']);
  });

  it('selects across multiple pitch rows', () => {
    const ids = marqueeSelect(notes, { x: 150, y: 665, width: 10, height: 10 }, view);
    expect(ids).toEqual(['a', 'c']);
  });

  it('returns ids in input order', () => {
    const reversed = [...notes].reverse();
    const ids = marqueeSelect(reversed, { x: 0, y: 0, width: 1000, height: 1280 }, view);
    expect(ids).toEqual(['c', 'b', 'a']);
  });

  it('handles an empty note list', () => {
    expect(marqueeSelect([], { x: 0, y: 0, width: 100, height: 100 }, view)).toEqual([]);
  });
});
