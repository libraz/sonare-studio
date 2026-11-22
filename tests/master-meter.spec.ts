import { describe, expect, it } from 'vitest';
import {
  correlationFraction,
  gainReductionAmountDb,
  gainReductionFraction,
  hasLoudnessData,
  loudnessDeltaLu,
  maxTruePeakDbtp,
} from '@/ui/mixer/master-meter';

describe('correlationFraction', () => {
  it('maps the correlation range onto a centred 0..1 bar', () => {
    expect(correlationFraction(-1)).toBe(0);
    expect(correlationFraction(0)).toBe(0.5);
    expect(correlationFraction(1)).toBe(1);
    expect(correlationFraction(0.5)).toBeCloseTo(0.75, 5);
  });

  it('clamps out-of-range and treats non-finite as centred', () => {
    expect(correlationFraction(-3)).toBe(0);
    expect(correlationFraction(3)).toBe(1);
    expect(correlationFraction(Number.NaN)).toBe(0.5);
    expect(correlationFraction(Number.POSITIVE_INFINITY)).toBe(0.5);
  });
});

describe('maxTruePeakDbtp', () => {
  it('returns the louder channel when both are present', () => {
    expect(maxTruePeakDbtp({ truePeakDbtpL: -3, truePeakDbtpR: -1 })).toBe(-1);
    expect(maxTruePeakDbtp({ truePeakDbtpL: -0.2, truePeakDbtpR: -6 })).toBe(-0.2);
  });

  it('falls back to whichever channel is present', () => {
    expect(maxTruePeakDbtp({ truePeakDbtpL: -2, truePeakDbtpR: undefined })).toBe(-2);
    expect(maxTruePeakDbtp({ truePeakDbtpL: undefined, truePeakDbtpR: -4 })).toBe(-4);
    expect(maxTruePeakDbtp({ truePeakDbtpL: undefined, truePeakDbtpR: undefined })).toBeUndefined();
  });
});

describe('gainReductionAmountDb', () => {
  it('reports the reduction magnitude regardless of sign convention', () => {
    expect(gainReductionAmountDb(-3.2)).toBeCloseTo(3.2, 5);
    expect(gainReductionAmountDb(3.2)).toBeCloseTo(3.2, 5);
  });

  it('treats near-zero, undefined and non-finite as no reduction', () => {
    expect(gainReductionAmountDb(0)).toBeUndefined();
    expect(gainReductionAmountDb(-0.05)).toBeUndefined();
    expect(gainReductionAmountDb(undefined)).toBeUndefined();
    expect(gainReductionAmountDb(Number.NaN)).toBeUndefined();
  });
});

describe('gainReductionFraction', () => {
  it('maps the reduction magnitude onto a clamped 0..1 bar', () => {
    expect(gainReductionFraction(0)).toBe(0);
    expect(gainReductionFraction(6)).toBeCloseTo(0.5, 5);
    expect(gainReductionFraction(12)).toBe(1);
    expect(gainReductionFraction(24)).toBe(1);
  });
});

describe('loudnessDeltaLu', () => {
  it('returns the signed difference from the target', () => {
    expect(loudnessDeltaLu(-12, -14)).toBeCloseTo(2, 5);
    expect(loudnessDeltaLu(-16, -14)).toBeCloseTo(-2, 5);
    expect(loudnessDeltaLu(-14, -14)).toBe(0);
  });

  it('is undefined while the integrated reading is absent or gating', () => {
    expect(loudnessDeltaLu(undefined, -14)).toBeUndefined();
    expect(loudnessDeltaLu(Number.NEGATIVE_INFINITY, -14)).toBeUndefined();
    expect(loudnessDeltaLu(Number.NaN, -14)).toBeUndefined();
  });
});

describe('hasLoudnessData', () => {
  it('is true when any full-record field is present', () => {
    expect(hasLoudnessData({ momentaryLufs: -14 })).toBe(true);
    expect(hasLoudnessData({ truePeakDbtpL: -1 })).toBe(true);
    expect(hasLoudnessData({ truePeakDbtpR: -1 })).toBe(true);
  });

  it('is false for a lightweight lane/bus record', () => {
    expect(hasLoudnessData({})).toBe(false);
    expect(
      hasLoudnessData({
        momentaryLufs: undefined,
        truePeakDbtpL: undefined,
        truePeakDbtpR: undefined,
      }),
    ).toBe(false);
  });
});
