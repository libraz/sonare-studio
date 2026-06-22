import { describe, expect, it } from 'vitest';
import {
  binFrequency,
  frequencyToFraction,
  goniometerXY,
  SPECTRUM_MAX_DB,
  SPECTRUM_MAX_FREQ,
  SPECTRUM_MIN_DB,
  SPECTRUM_MIN_FREQ,
  spectrumDbToFraction,
} from '@/ui/mixer/spectrum-model';

describe('frequencyToFraction', () => {
  it('maps the range edges to 0 and 1', () => {
    expect(frequencyToFraction(SPECTRUM_MIN_FREQ)).toBe(0);
    expect(frequencyToFraction(SPECTRUM_MAX_FREQ)).toBeCloseTo(1, 6);
  });

  it('places the geometric mean at the midpoint (log scale)', () => {
    const mid = Math.sqrt(SPECTRUM_MIN_FREQ * SPECTRUM_MAX_FREQ);
    expect(frequencyToFraction(mid)).toBeCloseTo(0.5, 6);
  });

  it('clamps out-of-range and non-finite inputs', () => {
    expect(frequencyToFraction(5)).toBe(0);
    expect(frequencyToFraction(40000)).toBe(1);
    expect(frequencyToFraction(0)).toBe(0);
    expect(frequencyToFraction(Number.NaN)).toBe(0);
  });
});

describe('spectrumDbToFraction', () => {
  it('maps the dB range edges to 0 and 1', () => {
    expect(spectrumDbToFraction(SPECTRUM_MIN_DB)).toBe(0);
    expect(spectrumDbToFraction(SPECTRUM_MAX_DB)).toBe(1);
  });

  it('maps the midpoint to 0.5', () => {
    expect(spectrumDbToFraction((SPECTRUM_MIN_DB + SPECTRUM_MAX_DB) / 2)).toBeCloseTo(0.5, 6);
  });

  it('clamps over-range and maps -Infinity (silence) to 0', () => {
    expect(spectrumDbToFraction(12)).toBe(1);
    expect(spectrumDbToFraction(-200)).toBe(0);
    expect(spectrumDbToFraction(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('binFrequency', () => {
  it('returns the bin centre frequency', () => {
    // Bin 1 of a 2048-pt FFT at 48 kHz is one bin width = 48000/2048 Hz.
    expect(binFrequency(1, 48000, 2048)).toBeCloseTo(48000 / 2048, 6);
    expect(binFrequency(0, 48000, 2048)).toBe(0);
    expect(binFrequency(1024, 48000, 2048)).toBeCloseTo(24000, 6);
  });

  it('guards against a zero FFT size', () => {
    expect(binFrequency(1, 48000, 0)).toBe(0);
  });
});

describe('goniometerXY', () => {
  it('places in-phase mono content on the vertical axis', () => {
    const { x, y } = goniometerXY(0.5, 0.5);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(2 * 0.5 * Math.SQRT1_2, 6);
    expect(y).toBeGreaterThan(0);
  });

  it('places out-of-phase content on the horizontal axis', () => {
    const { x, y } = goniometerXY(0.5, -0.5);
    expect(y).toBeCloseTo(0, 6);
    expect(Math.abs(x)).toBeCloseTo(2 * 0.5 * Math.SQRT1_2, 6);
  });

  it('keeps a hard-panned full-scale channel within the ±1 display', () => {
    const { x, y } = goniometerXY(1, 0);
    expect(Math.abs(x)).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.abs(y)).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.abs(x)).toBeLessThanOrEqual(1);
  });
});
