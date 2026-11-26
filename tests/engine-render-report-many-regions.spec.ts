import { describe, expect, it } from 'vitest';
import { buildReport } from '@/export/engine-render-report';

describe('buildReport clipping with many regions', () => {
  it('reports the earliest region start across 200k regions per channel', () => {
    const count = 200_000;
    const regions = (offset: number) =>
      Array.from({ length: count }, (_, i) => ({ startSample: offset + i * 2, length: 1 }));
    const metering = {
      detectClipping: (samples: Float32Array) => ({
        clippedSamples: count,
        maxClippedPeak: 1,
        regions: regions(samples[0] === 1 ? 7 : 5),
      }),
    };
    const left = new Float32Array([1, 0, 0, 0]);
    const right = new Float32Array([0, 0, 0, 0]);
    const report = buildReport(left, right, 48000, 4, metering);
    expect(report.clipping?.regionCount).toBe(count * 2);
    expect(report.clipping?.firstRegionStartSample).toBe(5);
  });

  it('omits unmeasured loudness windows and dynamic range', () => {
    const report = buildReport(new Float32Array([0]), new Float32Array([0]), 48000, 1, {
      multichannelLufs: () => ({ integratedLufs: Number.NEGATIVE_INFINITY }),
      dynamicRangeDb: () => undefined,
    });

    expect(report.lufs).toBe(Number.NEGATIVE_INFINITY);
    expect(report).not.toHaveProperty('momentaryLufs');
    expect(report).not.toHaveProperty('shortTermLufs');
    expect(report).not.toHaveProperty('loudnessRangeLu');
    expect(report).not.toHaveProperty('dynamicRangeDb');
  });

  it('preserves measured silence and an infinite dynamic range', () => {
    const report = buildReport(new Float32Array([0.25, 0]), new Float32Array([0, 0]), 48000, 2, {
      multichannelLufs: () => ({
        integratedLufs: -19,
        momentaryLufs: Number.NEGATIVE_INFINITY,
        shortTermLufs: Number.NEGATIVE_INFINITY,
      }),
      dynamicRangeDb: () => Number.POSITIVE_INFINITY,
    });

    expect(report.lufs).toBe(-19);
    expect(report.momentaryLufs).toBe(Number.NEGATIVE_INFINITY);
    expect(report.shortTermLufs).toBe(Number.NEGATIVE_INFINITY);
    expect(report).not.toHaveProperty('loudnessRangeLu');
    expect(report.dynamicRangeDb).toBe(Number.POSITIVE_INFINITY);
  });
});
