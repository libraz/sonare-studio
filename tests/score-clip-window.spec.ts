import { describe, expect, it } from 'vitest';
import { scoreClipWindow } from '@/notation/score-clip-window';

describe('scoreClipWindow', () => {
  it('rounds a regular clip up to complete measures', () => {
    expect(
      scoreClipWindow({
        clipStartPpq: 2,
        clipLengthPpq: 5,
        pickupLengthPpq: 1,
        timeSignatures: [],
      }),
    ).toEqual({
      timeSig: { beats: 4, beatUnit: 4 },
      measureLenPpq: 4,
      clipLengthPpq: 8,
    });
  });

  it('preserves an opening pickup before rounding the remaining bars', () => {
    expect(
      scoreClipWindow({
        clipStartPpq: 0,
        clipLengthPpq: 5,
        pickupLengthPpq: 1,
        timeSignatures: [],
      }).clipLengthPpq,
    ).toBe(5);
  });

  it('uses the meter in effect at the clip start', () => {
    expect(
      scoreClipWindow({
        clipStartPpq: 8,
        clipLengthPpq: 4,
        pickupLengthPpq: 0,
        timeSignatures: [
          { startPpq: 0, numerator: 4, denominator: 4 },
          { startPpq: 8, numerator: 3, denominator: 4 },
        ],
      }),
    ).toEqual({
      timeSig: { beats: 3, beatUnit: 4 },
      measureLenPpq: 3,
      clipLengthPpq: 6,
    });
  });
});
