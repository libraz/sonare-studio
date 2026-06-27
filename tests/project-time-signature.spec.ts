import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_SIGNATURE, timeSignatureAt } from '@/project/time-signature';
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
