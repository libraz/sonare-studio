import { describe, expect, it } from 'vitest';
import {
  CLIP_WARN_TRUE_PEAK_DB,
  formatLevel,
  isClippingRisk,
  loudnessBarFraction,
  rangeBarFraction,
} from '@/ui/mastering/loudness';
import {
  barLengthPpq,
  DEFAULT_PREVIEW_BARS,
  derivePreviewRange,
} from '@/ui/mastering/preview-range';

describe('barLengthPpq', () => {
  it('returns quarter notes per bar for common signatures', () => {
    expect(barLengthPpq({ startPpq: 0, numerator: 4, denominator: 4 })).toBe(4);
    expect(barLengthPpq({ startPpq: 0, numerator: 3, denominator: 4 })).toBe(3);
    expect(barLengthPpq({ startPpq: 0, numerator: 6, denominator: 8 })).toBe(3);
    expect(barLengthPpq({ startPpq: 0, numerator: 7, denominator: 8 })).toBe(3.5);
  });

  it('falls back to 4/4 for missing or unusable signatures', () => {
    expect(barLengthPpq()).toBe(4);
    expect(barLengthPpq({ startPpq: 0, numerator: 0, denominator: 4 })).toBe(4);
    expect(barLengthPpq({ startPpq: 0, numerator: 4, denominator: 0 })).toBe(4);
  });
});

describe('derivePreviewRange', () => {
  it('uses the loop window when a loop is active', () => {
    expect(derivePreviewRange({ enabled: true, startPpq: 16, endPpq: 48 })).toEqual({
      startPpq: 16,
      endPpq: 48,
    });
  });

  it('falls back to the first 8 bars when the loop is disabled or empty', () => {
    expect(derivePreviewRange({ enabled: false, startPpq: 16, endPpq: 48 })).toEqual({
      startPpq: 0,
      endPpq: 32,
    });
    expect(derivePreviewRange({ enabled: true, startPpq: 16, endPpq: 16 })).toEqual({
      startPpq: 0,
      endPpq: 32,
    });
    expect(derivePreviewRange({ enabled: true, startPpq: 48, endPpq: 16 })).toEqual({
      startPpq: 0,
      endPpq: 32,
    });
    expect(derivePreviewRange(null)).toEqual({ startPpq: 0, endPpq: 32 });
  });

  it('derives the fallback length from the time signature at the timeline start', () => {
    const range = derivePreviewRange(null, [
      { startPpq: 12, numerator: 4, denominator: 4 },
      { startPpq: 0, numerator: 3, denominator: 4 },
    ]);
    expect(range).toEqual({ startPpq: 0, endPpq: 8 * 3 });
  });

  it('honors a custom bar count and rejects unusable ones', () => {
    expect(derivePreviewRange(null, [], 2)).toEqual({ startPpq: 0, endPpq: 8 });
    expect(derivePreviewRange(null, [], 0)).toEqual({
      startPpq: 0,
      endPpq: DEFAULT_PREVIEW_BARS * 4,
    });
    expect(derivePreviewRange(null, [], Number.NaN)).toEqual({
      startPpq: 0,
      endPpq: DEFAULT_PREVIEW_BARS * 4,
    });
  });
});

describe('loudness readout helpers', () => {
  it('maps dB values onto a clamped bar fraction', () => {
    expect(loudnessBarFraction(0)).toBe(1);
    expect(loudnessBarFraction(-30)).toBeCloseTo(0.5);
    expect(loudnessBarFraction(-60)).toBe(0);
    expect(loudnessBarFraction(-90)).toBe(0);
    expect(loudnessBarFraction(6)).toBe(1);
    expect(loudnessBarFraction(undefined)).toBe(0);
    expect(loudnessBarFraction(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('maps LRA and dynamic-range values from a positive comparison scale', () => {
    expect(rangeBarFraction(0)).toBe(0);
    expect(rangeBarFraction(4.5)).toBeCloseTo(0.225, 5);
    expect(rangeBarFraction(9.1)).toBeCloseTo(0.455, 5);
    expect(rangeBarFraction(20)).toBe(1);
    expect(rangeBarFraction(30)).toBe(1);
  });

  it('formats levels with infinity and missing-value fallbacks', () => {
    expect(formatLevel(-6.25)).toBe('-6.3');
    expect(formatLevel(-14, 0)).toBe('-14');
    expect(formatLevel(Number.NEGATIVE_INFINITY)).toBe('-∞');
    expect(formatLevel(undefined)).toBe('—');
    expect(formatLevel(Number.NaN)).toBe('—');
  });

  it('flags true peaks above the warning threshold', () => {
    expect(CLIP_WARN_TRUE_PEAK_DB).toBe(-0.3);
    expect(isClippingRisk(-0.2)).toBe(true);
    expect(isClippingRisk(0.5)).toBe(true);
    expect(isClippingRisk(-0.3)).toBe(false);
    expect(isClippingRisk(-3)).toBe(false);
    expect(isClippingRisk(undefined)).toBe(false);
  });
});
