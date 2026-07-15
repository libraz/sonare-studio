import { describe, expect, it } from 'vitest';
import {
  advanceBarsPpq,
  countInStartPpq,
  DEFAULT_TIME_SIGNATURE,
  isFourFourBarRange,
  measureGrid,
  timeSignatureAt,
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

  it('walks count-in and generation bars over the real grid', () => {
    expect(countInStartPpq(meter, 8.5, 1)).toBe(6);
    expect(countInStartPpq(meter, 8.5, 2)).toBe(3);
    expect(advanceBarsPpq(meter, 3, 3)).toBe(11);
    expect(isFourFourBarRange(meter, 0, 1)).toBe(false);
    expect(isFourFourBarRange([], 0, 4)).toBe(true);
  });
});
