import { describe, expect, it } from 'vitest';
import {
  assertCodecPayloadMemory,
  assertRenderPayloadMemory,
  estimateCodecPayloadMemory,
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

    expect(streamed.retainedStereoBuffers).toBe(2);
    expect(streamed.transientStereoBuffers).toBe(1);
    expect(streamed.fullStereoBuffers).toBe(3);
    expect(collected.retainedStereoBuffers).toBe(101);
    expect(collected.fullStereoBuffers).toBe(102);
    expect(streamed.peakPayloadBytes).toBe(totalFrames * 24);
    expect(collected.peakPayloadBytes / streamed.peakPayloadBytes).toBe(34);
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

  it('counts source PCM, transformed schedules, fonts, and transient metering scratch', () => {
    const estimate = estimateRenderPayloadMemory({
      totalFrames: 48_000,
      stemCount: 0,
      streamingStems: true,
      sourceAudioBytes: 20 * MEBIBYTE,
      preparedClipBytes: 10 * MEBIBYTE,
      soundFontBytes: 5 * MEBIBYTE,
    });

    expect(estimate).toMatchObject({
      retainedStereoBuffers: 1,
      transientStereoBuffers: 1,
      sourceAudioBytes: 20 * MEBIBYTE,
      preparedClipBytes: 10 * MEBIBYTE,
      soundFontBytes: 5 * MEBIBYTE,
    });
    expect(estimate.peakPayloadBytes).toBe(35 * MEBIBYTE + 48_000 * 16);
  });

  it('rejects codec input/output/scratch before encoding starts', () => {
    const estimate = estimateCodecPayloadMemory({
      encoderId: 'flac',
      inputBytes: 300 * MEBIBYTE,
      retainedBytes: 100 * MEBIBYTE,
    });
    expect(estimate.codecScratchBytes).toBe(16 * MEBIBYTE);
    expect(() => assertCodecPayloadMemory(estimate, 512 * MEBIBYTE)).toThrow(
      /Audio encoding needs about/,
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
