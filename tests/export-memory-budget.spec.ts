import { describe, expect, it } from 'vitest';
import {
  assertRenderPayloadMemory,
  estimateRenderPayloadMemory,
  MEBIBYTE,
} from '@/export/memory-budget';
import { PayloadMemoryMeter, utf8ByteLength } from '@/lib/payload-memory';

describe('export payload memory benchmarks', () => {
  it('bounds 100 thirty-minute stems to the mix plus one acknowledged stem', () => {
    const totalFrames = 30 * 60 * 48000;
    const streamed = estimateRenderPayloadMemory({
      totalFrames,
      stemCount: 100,
      streamingStems: true,
    });
    const collected = estimateRenderPayloadMemory({
      totalFrames,
      stemCount: 100,
      streamingStems: false,
    });

    expect(streamed.fullStereoBuffers).toBe(2);
    expect(collected.fullStereoBuffers).toBe(101);
    expect(streamed.peakPayloadBytes).toBe(totalFrames * 16);
    expect(collected.peakPayloadBytes / streamed.peakPayloadBytes).toBe(50.5);
  });

  it('reports a graceful low-memory failure before allocation', () => {
    const estimate = estimateRenderPayloadMemory({
      totalFrames: 30 * 60 * 48000,
      stemCount: 100,
      streamingStems: true,
    });
    expect(() => assertRenderPayloadMemory(estimate, 512 * MEBIBYTE)).toThrow(
      /exceeding the 512 MiB browser budget/,
    );
  });

  it('tracks and releases one consumer payload at a time', () => {
    const samples: number[] = [];
    const meter = new PayloadMemoryMeter({
      label: 'CI payload benchmark',
      budgetBytes: MEBIBYTE,
      onSample: (sample) => samples.push(sample.activeBytes),
      readBrowserHeapBytes: () => 1234,
    });
    for (let index = 0; index < 500; index += 1) {
      const release = meter.retain(64 * 1024, `page ${index + 1}`);
      release();
    }
    expect(Math.max(...samples)).toBe(64 * 1024);
    expect(meter.snapshot()).toMatchObject({
      activeBytes: 0,
      peakActiveBytes: 64 * 1024,
      processedUnits: 500,
      browserHeapBytes: 1234,
      peakBrowserHeapBytes: 1234,
    });
  });

  it('counts UTF-8 bytes without allocating an encoded copy', () => {
    const text = 'ASCII / 日本語 / \u{1F3BC} / \ud800';
    expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).byteLength);
  });
});
