import { describe, expect, it } from 'vitest';
import { pianoRollStatusLocation } from '@/components/piano-roll/status-location';

describe('pianoRollStatusLocation', () => {
  it('resolves only the hovered variable-meter measure', () => {
    const meter = [
      { startPpq: 0, numerator: 3, denominator: 4 },
      { startPpq: 6, numerator: 5, denominator: 8 },
    ];

    expect(pianoRollStatusLocation(meter, 5.5)).toEqual({ bar: 2, beat: 3 });
    expect(pianoRollStatusLocation(meter, 7.9)).toEqual({ bar: 3, beat: 4 });
  });
});
