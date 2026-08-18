import { describe, expect, it } from 'vitest';
import {
  advanceBarsPpq,
  countInStartPpq,
  DEFAULT_TIME_SIGNATURE,
  isFourFourBarRange,
  measureGrid,
  measureRangeAt,
  normalizeTimeSignatureMap,
  snapPpqToMeterGrid,
  snapPpqToSwingMeterGrid,
  timeSignatureAt,
  timeSignatureRanges,
  toMeterMap,
} from '@/project/time-signature';
import type { TimeSignatureSegment } from '@/project/types';

describe('timeSignatureAt', () => {
  it('falls back to 4/4 for an empty meter map', () => {
    expect(timeSignatureAt([], 0)).toEqual({ numerator: 4, denominator: 4 });
    expect(timeSignatureAt([], 9600)).toEqual(DEFAULT_TIME_SIGNATURE);
  });

  it('returns the segment active at the position', () => {
    const segments: TimeSignatureSegment[] = [
      { startPpq: 0, numerator: 3, denominator: 4 },
      { startPpq: 2880, numerator: 6, denominator: 8 },
      { startPpq: 9600, numerator: 5, denominator: 4 },
    ];
    expect(timeSignatureAt(segments, 0)).toEqual({ numerator: 3, denominator: 4 });
    expect(timeSignatureAt(segments, 2879)).toEqual({ numerator: 3, denominator: 4 });
    expect(timeSignatureAt(segments, 2880)).toEqual({ numerator: 6, denominator: 8 });
    expect(timeSignatureAt(segments, 5000)).toEqual({ numerator: 6, denominator: 8 });
    expect(timeSignatureAt(segments, 100000)).toEqual({ numerator: 5, denominator: 4 });
  });

  it('falls back to 4/4 when the position precedes the first segment', () => {
    const segments: TimeSignatureSegment[] = [{ startPpq: 1920, numerator: 7, denominator: 8 }];
    expect(timeSignatureAt(segments, 0)).toEqual({ numerator: 4, denominator: 4 });
  });

  it('returns a fresh object (callers may mutate it safely)', () => {
    const a = timeSignatureAt([], 0);
    a.numerator = 9;
    expect(timeSignatureAt([], 0)).toEqual({ numerator: 4, denominator: 4 });
  });
});

describe('variable-meter measure grid', () => {
  const meter: TimeSignatureSegment[] = [
    { startPpq: 0, numerator: 3, denominator: 4 },
    { startPpq: 6, numerator: 5, denominator: 8 },
  ];

  it('shares exact 3/4 to 5/8 measure boundaries', () => {
    expect(measureGrid(meter, 0, 11)).toEqual([
      { startPpq: 0, lengthPpq: 3, numerator: 3, denominator: 4, index: 0 },
      { startPpq: 3, lengthPpq: 3, numerator: 3, denominator: 4, index: 1 },
      { startPpq: 6, lengthPpq: 2.5, numerator: 5, denominator: 8, index: 2 },
      { startPpq: 8.5, lengthPpq: 2.5, numerator: 5, denominator: 8, index: 3 },
    ]);
  });

  it('reanchors numeric grids and supports full-bar snapping', () => {
    expect(snapPpqToMeterGrid(meter, 6.8, 1)).toBe(7);
    expect(snapPpqToMeterGrid(meter, 7.1, 'bar')).toBe(6);
    expect(snapPpqToMeterGrid(meter, 8.2, 'bar')).toBe(8.5);
  });

  it('applies swing only to straight locally anchored grids', () => {
    expect(snapPpqToSwingMeterGrid(meter, 6.6, 0.5, 100)).toBeCloseTo(6 + 0.5 + 0.5 / 3, 12);
    expect(snapPpqToSwingMeterGrid(meter, 6.6, 1 / 3, 100)).toBeCloseTo(6 + 2 / 3, 12);
    expect(snapPpqToSwingMeterGrid(meter, 8.2, 'bar', 100)).toBe(8.5);
  });

  it('walks count-in and generation bars over the real grid', () => {
    expect(countInStartPpq(meter, 8.5, 1)).toBe(6);
    expect(countInStartPpq(meter, 8.5, 2)).toBe(3);
    expect(advanceBarsPpq(meter, 3, 3)).toBe(11);
    expect(isFourFourBarRange(meter, 0, 1)).toBe(false);
    expect(isFourFourBarRange([], 0, 4)).toBe(true);
  });
});

describe('measureRangeAt across a mid-bar meter change', () => {
  const cutShort: TimeSignatureSegment[] = [
    { startPpq: 0, numerator: 4, denominator: 4 },
    { startPpq: 9, numerator: 3, denominator: 4 },
  ];
  const twoChanges: TimeSignatureSegment[] = [
    { startPpq: 0, numerator: 4, denominator: 4 },
    { startPpq: 6, numerator: 7, denominator: 8 },
    { startPpq: 13.5, numerator: 3, denominator: 4 },
  ];

  it('truncates the bar the change lands in and starts a full one at the change', () => {
    // The third 4/4 bar would run 8..12, but the change at 9 ends it there.
    expect(measureRangeAt(cutShort, 8.5)).toEqual({
      startPpq: 8,
      lengthPpq: 1,
      numerator: 4,
      denominator: 4,
      index: 2,
    });
    expect(measureRangeAt(cutShort, 9)).toEqual({
      startPpq: 9,
      lengthPpq: 3,
      numerator: 3,
      denominator: 4,
      index: 3,
    });
  });

  it('truncates at each of two changes', () => {
    expect(measureRangeAt(twoChanges, 5)).toEqual({
      startPpq: 4,
      lengthPpq: 2,
      numerator: 4,
      denominator: 4,
      index: 1,
    });
    expect(measureRangeAt(twoChanges, 6)).toEqual({
      startPpq: 6,
      lengthPpq: 3.5,
      numerator: 7,
      denominator: 8,
      index: 2,
    });
    // 6 + 3.5 + 3.5 = 13, so the third 7/8 bar has half a beat before 13.5.
    expect(measureRangeAt(twoChanges, 13.4)).toEqual({
      startPpq: 13,
      lengthPpq: 0.5,
      numerator: 7,
      denominator: 8,
      index: 4,
    });
    expect(measureRangeAt(twoChanges, 13.5)).toEqual({
      startPpq: 13.5,
      lengthPpq: 3,
      numerator: 3,
      denominator: 4,
      index: 5,
    });
  });

  it('numbers bars consecutively across a change, with no gap and no repeat', () => {
    const indices: number[] = [];
    let cursor = 0;
    for (let bar = 0; bar < 8; bar += 1) {
      const range = measureRangeAt(twoChanges, cursor);
      indices.push(range.index);
      cursor = range.startPpq + range.lengthPpq;
    }
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('clamps a position at or before zero to the first bar', () => {
    const first = { startPpq: 0, lengthPpq: 4, numerator: 4, denominator: 4, index: 0 };
    expect(measureRangeAt(cutShort, 0)).toEqual(first);
    expect(measureRangeAt(cutShort, -0.5)).toEqual(first);
    expect(measureRangeAt(cutShort, -1000)).toEqual(first);
  });

  it('counts bars from zero when the map starts late, rather than as a pickup', () => {
    const late: TimeSignatureSegment[] = [{ startPpq: 8, numerator: 3, denominator: 4 }];
    expect(measureRangeAt(late, 0)).toEqual({
      startPpq: 0,
      lengthPpq: 4,
      numerator: 4,
      denominator: 4,
      index: 0,
    });
    expect(measureRangeAt(late, 9)).toEqual({
      startPpq: 8,
      lengthPpq: 3,
      numerator: 3,
      denominator: 4,
      index: 2,
    });
  });
});

describe('normalizeTimeSignatureMap and toMeterMap', () => {
  it('keeps an additive grouping the meter arithmetic can read', () => {
    expect(
      normalizeTimeSignatureMap([
        { startPpq: 0, numerator: 7, denominator: 8, grouping: [2, 2, 3] },
      ]),
    ).toEqual([{ startPpq: 0, numerator: 7, denominator: 8, grouping: [2, 2, 3] }]);
    // A compound numerator also accepts its groups counted in main pulses.
    expect(
      normalizeTimeSignatureMap([
        { startPpq: 0, numerator: 9, denominator: 8, grouping: [1, 1, 1] },
      ]),
    ).toEqual([{ startPpq: 0, numerator: 9, denominator: 8, grouping: [1, 1, 1] }]);
  });

  it.each([
    ['sums to neither units nor pulses', [2, 2, 2]],
    ['holds a zero group', [2, 0, 5]],
    ['holds a fractional group', [3.5, 3.5]],
    ['is empty', []],
  ])('drops a grouping that %s', (_label, grouping) => {
    expect(
      normalizeTimeSignatureMap([{ startPpq: 0, numerator: 7, denominator: 8, grouping }]),
    ).toEqual([{ startPpq: 0, numerator: 7, denominator: 8 }]);
  });

  it('sorts, deduplicates and covers PPQ zero', () => {
    expect(
      toMeterMap([
        { startPpq: 6, numerator: 3, denominator: 4 },
        { startPpq: 6, numerator: 5, denominator: 8 },
        { startPpq: -1, numerator: 2, denominator: 4 },
        { startPpq: 4, numerator: 0, denominator: 4 },
        { startPpq: 2, numerator: 7, denominator: 8, grouping: [2, 2, 3] },
      ]),
    ).toEqual([
      { startBeat: 0, ts: { numerator: 4, denominator: 4 } },
      { startBeat: 2, ts: { numerator: 7, denominator: 8, grouping: [2, 2, 3] } },
      { startBeat: 6, ts: { numerator: 5, denominator: 8 } },
    ]);
  });
});

describe('timeSignatureRanges', () => {
  it('clips a batch window at every governing meter boundary', () => {
    expect(
      timeSignatureRanges(
        [
          { startPpq: 0, numerator: 4, denominator: 4 },
          { startPpq: 6, numerator: 3, denominator: 4 },
          { startPpq: 11, numerator: 5, denominator: 8 },
        ],
        2,
        14,
      ),
    ).toEqual([
      { startPpq: 2, endPpq: 6, numerator: 4, denominator: 4 },
      { startPpq: 6, endPpq: 11, numerator: 3, denominator: 4 },
      { startPpq: 11, endPpq: 14, numerator: 5, denominator: 8 },
    ]);
  });

  it('supplies the 4/4 fallback before a late first map entry', () => {
    expect(timeSignatureRanges([{ startPpq: 8, numerator: 3, denominator: 4 }], 2, 10)).toEqual([
      { startPpq: 2, endPpq: 8, numerator: 4, denominator: 4 },
      { startPpq: 8, endPpq: 10, numerator: 3, denominator: 4 },
    ]);
  });
});
