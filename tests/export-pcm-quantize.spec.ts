import { describe, expect, it } from 'vitest';
import { quantizePcmSample, scalePcmSample } from '@/export/pcm-quantize';

describe('scalePcmSample', () => {
  it('scales negative samples by the negative full scale', () => {
    expect(scalePcmSample(-1, 0x7fff, 0x8000)).toBe(-0x8000);
    expect(scalePcmSample(-0.5, 0x7fff, 0x8000)).toBe(-0x4000);
  });

  it('scales non-negative samples by the positive full scale', () => {
    expect(scalePcmSample(1, 0x7fff, 0x8000)).toBe(0x7fff);
    expect(scalePcmSample(0, 0x7fff, 0x8000)).toBe(0);
  });
});

describe('quantizePcmSample', () => {
  it('reaches both signed-PCM extremes at full scale', () => {
    expect(quantizePcmSample(1, 0x7fff, 0x8000)).toBe(0x7fff);
    expect(quantizePcmSample(-1, 0x7fff, 0x8000)).toBe(-0x8000);
    expect(quantizePcmSample(1, 0x7fffff, 0x800000)).toBe(0x7fffff);
    expect(quantizePcmSample(-1, 0x7fffff, 0x800000)).toBe(-0x800000);
  });

  it('hard-clips over-range input before quantizing', () => {
    expect(quantizePcmSample(2.5, 0x7fff, 0x8000)).toBe(0x7fff);
    expect(quantizePcmSample(-3, 0x7fff, 0x8000)).toBe(-0x8000);
  });

  it('rounds half-up', () => {
    expect(quantizePcmSample(0.25, 0x7fff, 0x8000)).toBe(Math.round(0.25 * 0x7fff));
  });
});
