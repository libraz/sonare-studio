import { describe, expect, it } from 'vitest';
import { createDefaultStrip, stripCacheSegment, stripHasDsp } from '@/project/mixer';

describe('mixer strip DSP identity', () => {
  it('treats strip-local trim width and polarity as DSP-affecting state', () => {
    expect(stripHasDsp(createDefaultStrip())).toBe(false);
    expect(stripHasDsp({ ...createDefaultStrip(), inputTrimDb: -3 })).toBe(true);
    expect(stripHasDsp({ ...createDefaultStrip(), width: 0.5 })).toBe(true);
    expect(stripHasDsp({ ...createDefaultStrip(), polarityInvertLeft: true })).toBe(true);
    expect(stripHasDsp({ ...createDefaultStrip(), polarityInvertRight: true })).toBe(true);
  });

  it('changes the processed-buffer cache key for trim width and polarity edits', () => {
    const base = stripCacheSegment(createDefaultStrip());

    expect(stripCacheSegment({ ...createDefaultStrip(), inputTrimDb: -3 })).not.toBe(base);
    expect(stripCacheSegment({ ...createDefaultStrip(), width: 0.5 })).not.toBe(base);
    expect(stripCacheSegment({ ...createDefaultStrip(), polarityInvertLeft: true })).not.toBe(base);
    expect(stripCacheSegment({ ...createDefaultStrip(), polarityInvertRight: true })).not.toBe(
      base,
    );
  });

  it('keeps gain and pan out of the processed-buffer cache key', () => {
    const base = stripCacheSegment({
      ...createDefaultStrip(),
      inserts: [{ processor: 'dynamics.compressor', params: { thresholdDb: -18 }, enabled: true }],
    });

    expect(
      stripCacheSegment({
        ...createDefaultStrip(),
        gainDb: -6,
        pan: 0.75,
        inserts: [
          { processor: 'dynamics.compressor', params: { thresholdDb: -18 }, enabled: true },
        ],
      }),
    ).toBe(base);
  });
});
