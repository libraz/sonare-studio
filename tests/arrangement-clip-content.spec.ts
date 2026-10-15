import { describe, expect, it } from 'vitest';
import {
  arrangementMidiNoteSpans,
  type ClipNoteSpan,
  clipContentMode,
  densityBuckets,
  MIN_MINI_NOTE_PITCH_SPAN,
  MINI_NOTES_MIN_PX_PER_BEAT,
  visibleMiniNoteRects,
} from '@/ui/arrangement/clip-content';

const note = (startPpq: number, durationPpq: number, pitch: number): ClipNoteSpan => ({
  startPpq,
  durationPpq,
  pitch,
});

describe('clipContentMode', () => {
  it('switches to mini-notes exactly at the px-per-beat threshold', () => {
    expect(clipContentMode(MINI_NOTES_MIN_PX_PER_BEAT)).toBe('mini-notes');
    expect(clipContentMode(MINI_NOTES_MIN_PX_PER_BEAT - 0.01)).toBe('density');
    expect(clipContentMode(1000)).toBe('mini-notes');
    expect(clipContentMode(0)).toBe('density');
  });
});

/** Rects for a window with the whole window visible. */
const miniNoteRects = (notes: ClipNoteSpan[], windowStartPpq: number, windowLengthPpq: number) =>
  visibleMiniNoteRects(
    notes,
    windowStartPpq,
    windowLengthPpq,
    windowStartPpq,
    windowStartPpq + windowLengthPpq,
  );

describe('miniNoteRects', () => {
  it('maps note time into window-relative unit coordinates', () => {
    const rects = miniNoteRects([note(0, 2, 60)], 0, 8);
    expect(rects).toHaveLength(1);
    expect(rects[0].u).toBe(0);
    expect(rects[0].uWidth).toBeCloseTo(0.25);
  });

  it('clips notes to the audible window', () => {
    const rects = miniNoteRects([note(-1, 2, 60), note(7, 4, 60)], 0, 8);
    expect(rects).toHaveLength(2);
    expect(rects[0].u).toBe(0);
    expect(rects[0].uWidth).toBeCloseTo(1 / 8);
    expect(rects[1].u).toBeCloseTo(7 / 8);
    expect(rects[1].uWidth).toBeCloseTo(1 / 8);
  });

  it('drops notes entirely outside the window', () => {
    expect(miniNoteRects([note(10, 1, 60)], 0, 8)).toEqual([]);
    expect(miniNoteRects([note(0, 2, 60)], 4, 4)).toEqual([]);
  });

  it('pads a narrow pitch range to the minimum span and centers it', () => {
    const rects = miniNoteRects([note(0, 1, 60)], 0, 4);
    expect(rects[0].vHeight).toBeCloseTo(1 / MIN_MINI_NOTE_PITCH_SPAN);
    // A single pitch sits centered: v + vHeight/2 = 0.5.
    expect(rects[0].v + rects[0].vHeight / 2).toBeCloseTo(0.5);
  });

  it('scales a wide pitch range to the full clip height', () => {
    const rects = miniNoteRects([note(0, 1, 50), note(1, 1, 70)], 0, 4);
    const span = 70 - 50 + 1;
    expect(rects[0].vHeight).toBeCloseTo(1 / span);
    // Higher pitch renders at the top.
    expect(rects[1].v).toBeCloseTo(0);
    expect(rects[0].v).toBeCloseTo(20 / span);
  });

  it('returns nothing for an empty note list or degenerate window', () => {
    expect(miniNoteRects([], 0, 8)).toEqual([]);
    expect(miniNoteRects([note(0, 1, 60)], 0, 0)).toEqual([]);
  });
});

describe('visibleMiniNoteRects', () => {
  it('returns only the visible notes while retaining a sustained off-screen onset', () => {
    const rects = visibleMiniNoteRects(
      [note(0, 100, 40), note(5, 1, 50), note(10, 1, 60), note(15, 1, 70)],
      0,
      40,
      10,
      15,
    );

    expect(rects).toHaveLength(2);
    // Rectangles stay in full-clip coordinates: the note at 10 starts at
    // 10/40, even though the visible sub-window starts at 10.
    expect(rects[0].u).toBe(0);
    expect(rects[0].uWidth).toBeCloseTo(1);
    expect(rects[1].u).toBeCloseTo(10 / 40);
    expect(rects[1].uWidth).toBeCloseTo(1 / 40);
  });

  it('culls notes that only touch the visible sub-window edges', () => {
    const rects = visibleMiniNoteRects(
      [note(9, 1, 60), note(10, 1, 60), note(15, 1, 60)],
      0,
      20,
      10,
      15,
    );
    expect(rects).toHaveLength(1);
    expect(rects[0].u).toBeCloseTo(0.5);
  });
});

describe('arrangementMidiNoteSpans', () => {
  it('repeats the canonical audible loop window and clips the final occurrence', () => {
    const spans = arrangementMidiNoteSpans({
      id: 8,
      startPpq: 12,
      lengthPpq: 5,
      sourceOffsetPpq: 1,
      loopEnabled: true,
      loopLengthPpq: 2,
      notes: [{ id: 4, startPpq: 1.5, durationPpq: 1, pitch: 64, velocity: 100, channel: 0 }],
    });

    expect(spans).toEqual([note(0.5, 1, 64), note(2.5, 1, 64), note(4.5, 0.5, 64)]);
  });
});

describe('densityBuckets', () => {
  it('counts notes per bucket and normalizes to the peak', () => {
    const notes = [note(0, 1, 60), note(4, 1, 62), note(5, 1, 64), note(14, 1, 66)];
    expect(densityBuckets(notes, 0, 16, 4)).toEqual([0.5, 1, 0, 0.5]);
  });

  it('credits a note to every bucket it overlaps', () => {
    expect(densityBuckets([note(3, 2, 60)], 0, 16, 4)).toEqual([1, 1, 0, 0]);
  });

  it('covers a window that is not a whole number of buckets', () => {
    expect(densityBuckets([note(9, 0.5, 60)], 0, 10, 4)).toEqual([0, 0, 1]);
  });

  it('honors the window start offset', () => {
    // The window starts at source PPQ 8; a note at 9 lands in bucket 0.
    expect(densityBuckets([note(9, 1, 60)], 8, 8, 4)).toEqual([1, 0]);
  });

  it('returns all-zero buckets for an empty clip', () => {
    expect(densityBuckets([], 0, 16, 4)).toEqual([0, 0, 0, 0]);
  });

  it('returns nothing for non-positive window or bucket sizes', () => {
    expect(densityBuckets([note(0, 1, 60)], 0, 0, 4)).toEqual([]);
    expect(densityBuckets([note(0, 1, 60)], 0, 16, 0)).toEqual([]);
  });
});
