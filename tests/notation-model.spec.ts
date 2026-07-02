import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIVISIONS,
  NOTE_VALUE_BASES,
  type NoteValue,
  type NoteValueDots,
  noteValueToPpq,
  ppqToDivisions,
  ppqToNoteValue,
  timeSigLengthPpq,
} from '@/notation/model';

describe('noteValueToPpq', () => {
  it('returns exact durations for plain values', () => {
    expect(noteValueToPpq({ base: 'whole', dots: 0 })).toBe(4);
    expect(noteValueToPpq({ base: 'half', dots: 0 })).toBe(2);
    expect(noteValueToPpq({ base: 'quarter', dots: 0 })).toBe(1);
    expect(noteValueToPpq({ base: 'eighth', dots: 0 })).toBe(0.5);
    expect(noteValueToPpq({ base: '16th', dots: 0 })).toBe(0.25);
    expect(noteValueToPpq({ base: '32nd', dots: 0 })).toBe(0.125);
    expect(noteValueToPpq({ base: '64th', dots: 0 })).toBe(0.0625);
  });

  it('scales dotted values by 1.5', () => {
    expect(noteValueToPpq({ base: 'quarter', dots: 1 })).toBe(1.5);
    expect(noteValueToPpq({ base: 'eighth', dots: 1 })).toBe(0.75);
    expect(noteValueToPpq({ base: 'whole', dots: 1 })).toBe(6);
  });

  it('scales double-dotted values by 1.75', () => {
    expect(noteValueToPpq({ base: 'half', dots: 2 })).toBe(3.5);
    expect(noteValueToPpq({ base: 'quarter', dots: 2 })).toBe(1.75);
    expect(noteValueToPpq({ base: 'whole', dots: 2 })).toBe(7);
  });

  it('scales triplet values by 2:3', () => {
    expect(noteValueToPpq({ base: 'eighth', dots: 0, tuplet: { actual: 3, normal: 2 } })).toBe(
      1 / 3,
    );
    expect(noteValueToPpq({ base: 'quarter', dots: 0, tuplet: { actual: 3, normal: 2 } })).toBe(
      2 / 3,
    );
  });
});

describe('ppqToNoteValue', () => {
  it('round-trips every base/dot combination', () => {
    for (const base of NOTE_VALUE_BASES) {
      for (const dots of [0, 1, 2] as NoteValueDots[]) {
        const value: NoteValue = { base, dots };
        expect(ppqToNoteValue(noteValueToPpq(value))).toEqual(value);
      }
    }
  });

  it('snaps near misses to the nearest representable value', () => {
    expect(ppqToNoteValue(1 / 3)).toEqual({
      base: 'eighth',
      dots: 0,
      tuplet: { actual: 3, normal: 2 },
    });
    expect(ppqToNoteValue(0.95)).toEqual({ base: 'quarter', dots: 0 });
    expect(ppqToNoteValue(0.9)).toEqual({ base: 'eighth', dots: 2 });
    expect(ppqToNoteValue(1.6)).toEqual({ base: 'quarter', dots: 1 });
    expect(ppqToNoteValue(0.7)).toEqual({ base: 'eighth', dots: 1 });
    expect(ppqToNoteValue(3.4)).toEqual({ base: 'half', dots: 2 });
  });

  it('prefers fewer dots on exact ties', () => {
    // 1.25 is equidistant from quarter (1.0) and dotted quarter (1.5).
    expect(ppqToNoteValue(1.25)).toEqual({ base: 'quarter', dots: 0 });
    // 0.625 is equidistant from eighth (0.5) and dotted eighth (0.75).
    expect(ppqToNoteValue(0.625)).toEqual({ base: 'eighth', dots: 0 });
  });

  it('clamps out-of-range durations to the extremes', () => {
    expect(ppqToNoteValue(100)).toEqual({ base: 'whole', dots: 2 });
    expect(ppqToNoteValue(0.001)).toEqual({ base: '64th', dots: 0 });
  });

  it('rejects non-positive and non-finite input', () => {
    expect(() => ppqToNoteValue(0)).toThrow(RangeError);
    expect(() => ppqToNoteValue(-1)).toThrow(RangeError);
    expect(() => ppqToNoteValue(Number.NaN)).toThrow(RangeError);
    expect(() => ppqToNoteValue(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('timeSigLengthPpq', () => {
  it('computes the measure length in quarter-note PPQ', () => {
    expect(timeSigLengthPpq({ beats: 4, beatUnit: 4 })).toBe(4);
    expect(timeSigLengthPpq({ beats: 3, beatUnit: 4 })).toBe(3);
    expect(timeSigLengthPpq({ beats: 6, beatUnit: 8 })).toBe(3);
    expect(timeSigLengthPpq({ beats: 2, beatUnit: 2 })).toBe(4);
    expect(timeSigLengthPpq({ beats: 7, beatUnit: 16 })).toBe(1.75);
  });
});

describe('ppqToDivisions', () => {
  it('converts PPQ to integral divisions', () => {
    expect(ppqToDivisions(1, DEFAULT_DIVISIONS)).toBe(960);
    expect(ppqToDivisions(0.5, DEFAULT_DIVISIONS)).toBe(480);
    expect(ppqToDivisions(0.0625, DEFAULT_DIVISIONS)).toBe(60);
    // Double-dotted 64th (7/64 quarter) stays integral with the default.
    expect(ppqToDivisions(noteValueToPpq({ base: '64th', dots: 2 }), DEFAULT_DIVISIONS)).toBe(105);
  });

  it('rounds to the nearest division', () => {
    expect(ppqToDivisions(0.0004, 960)).toBe(0);
    expect(ppqToDivisions(0.001, 960)).toBe(1);
  });
});
