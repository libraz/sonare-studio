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
      clipLengthPpq: 6,
    });
  });

  it('ends a mid-bar clip on the project barline at or after its end', () => {
    const window = (clipStartPpq: number, clipLengthPpq: number) =>
      scoreClipWindow({ clipStartPpq, clipLengthPpq, pickupLengthPpq: 0, timeSignatures: [] })
        .clipLengthPpq;
    expect(window(2, 2)).toBe(2);
    expect(window(2, 3)).toBe(6);
    expect(window(1, 7)).toBe(7);
  });

  it('completes the last bar across a meter change inside the clip', () => {
    const timeSignatures = [
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 4, numerator: 3, denominator: 4 },
    ];
    // Clip end 8 falls inside the 3/4 bar 7..10.
    expect(
      scoreClipWindow({ clipStartPpq: 0, clipLengthPpq: 8, pickupLengthPpq: 0, timeSignatures })
        .clipLengthPpq,
    ).toBe(10);
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
