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

  it('rejects a thirty-minute stereo export with several retained assets before encoding', () => {
    // Three source assets (120 + 96 + 84 MiB) remain available while the
    // mix, the current streamed stem, and metering scratch are live.
    const estimate = estimateRenderPayloadMemory({
      totalFrames: 30 * 60 * 48_000,
      stemCount: 3,
      streamingStems: true,
      sourceAudioBytes: (120 + 96 + 84) * MEBIBYTE,
    });

    expect(estimate.fullStereoBuffers).toBe(3);
    expect(estimate.peakPayloadBytes).toBeGreaterThan(512 * MEBIBYTE);
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

  it('counts MediaRecorder PCM and encoded copies before AAC or Opus starts', () => {
    const inputBytes = 100 * MEBIBYTE;
    const estimate = estimateCodecPayloadMemory({ encoderId: 'aac', inputBytes });

    expect(estimate).toMatchObject({
      inputGenerations: 2,
      encodedGenerations: 2,
      codecScratchBytes: inputBytes,
      outputUpperBoundBytes: 2 * (inputBytes + 64 * 1024),
    });
    expect(() => assertCodecPayloadMemory(estimate, 400 * MEBIBYTE)).toThrow(
      /Audio encoding needs about/,
    );
  });

  it('counts FLAC frame chunks and final concatenation as separate outputs', () => {
    const estimate = estimateCodecPayloadMemory({ encoderId: 'flac', inputBytes: 100 * MEBIBYTE });

    expect(estimate.encodedGenerations).toBe(2);
    expect(estimate.outputUpperBoundBytes).toBe(2 * (100 * MEBIBYTE + 64 * 1024));
  });

  it('counts the worker transfer copy once without charging main-thread encoders', () => {
    const inputBytes = 100 * MEBIBYTE;
    const worker = estimateCodecPayloadMemory({
      encoderId: 'wav',
      inputBytes,
      workerBacked: true,
    });
    const mainThread = estimateCodecPayloadMemory({ encoderId: 'wav', inputBytes });

    expect(worker.workerInputCopyBytes).toBe(inputBytes);
    expect(worker.codecScratchBytes).toBe(inputBytes);
    expect(worker.peakPayloadBytes - mainThread.peakPayloadBytes).toBe(inputBytes);
    expect(mainThread.workerInputCopyBytes).toBe(0);
    expect(mainThread.codecScratchBytes).toBe(0);
  });

  it('tracks and releases one consumer payload at a time', () => {
    const samples: number[] = [];
    const meter = new PayloadMemoryMeter({
      operation: 'audio-export',
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
