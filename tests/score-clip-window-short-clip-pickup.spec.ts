import { describe, expect, it } from 'vitest';
import { quantizeToScore } from '@/notation/quantize';
import { scoreClipWindow, scoreOnsetResolver } from '@/notation/score-clip-window';

describe('a clip that ends inside the opening pickup', () => {
  const input = { clipStartPpq: 0, clipLengthPpq: 1, pickupLengthPpq: 1.5, timeSignatures: [] };

  it('ends the score window at the pickup barline', () => {
    expect(scoreClipWindow(input).clipLengthPpq).toBe(1.5);
  });

  it('engraves the pickup alone, with no empty bar after it', () => {
    const window = scoreClipWindow(input);
    const score = quantizeToScore([], {
      divisionPpq: 0.25,
      timeSig: window.timeSig,
      keyFifths: 0,
      clipStartPpq: 0,
      clipLengthPpq: window.clipLengthPpq,
      pickupLengthPpq: input.pickupLengthPpq,
    });
    expect(score.parts[0].measures.map((measure) => [measure.startPpq, measure.lengthPpq])).toEqual(
      [[0, 1.5]],
    );
  });

  it('resolves a click onset on the same grid', () => {
    expect(scoreOnsetResolver(input, 0.25)({ startPpq: 0.6, durationPpq: 0.2 })).toBe(0.5);
  });
});
