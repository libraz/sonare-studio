import { describe, expect, it, vi } from 'vitest';
import {
  type ChannelPeaks,
  computePeaks,
  createWaveformPeaksCache,
  mergePeaks,
  type WaveformPeaksModule,
} from '@/ui/waveform/peaks';

/** Shorthand for a peaks pair from plain number arrays. */
function peaks(min: number[], max: number[]): ChannelPeaks {
  return { min: new Float32Array(min), max: new Float32Array(max) };
}

describe('computePeaks (pure path)', () => {
  it('computes per-bucket min/max for one channel', () => {
    const channel = new Float32Array([1, -1, 2, -2, 3, -3, 4, -4]);
    expect(computePeaks([channel], 4)).toEqual([peaks([-1, -2, -3, -4], [1, 2, 3, 4])]);
  });

  it('handles bucket boundaries that do not divide the frame count', () => {
    const channel = new Float32Array([0, 1, 2, 3, 4]);
    // 5 frames over 2 buckets: [0,1] and [2,3,4].
    expect(computePeaks([channel], 2)).toEqual([peaks([0, 2], [1, 4])]);
  });

  it('distributes sparse frames proportionally and zero-fills empty buckets', () => {
    // 2 frames over 4 buckets: frames land in buckets 1 and 3, the others
    // stay empty (0/0).
    const channel = new Float32Array([5, -5]);
    expect(computePeaks([channel], 4)).toEqual([peaks([0, 5, 0, -5], [0, 5, 0, -5])]);
  });

  it('returns one peaks pair per channel', () => {
    const result = computePeaks([new Float32Array([1, 2]), new Float32Array([-1, -2])], 1);
    expect(result).toEqual([peaks([1], [2]), peaks([-2], [-1])]);
  });

  it('returns an empty list for no channels and zero-filled buckets for empty audio', () => {
    expect(computePeaks([], 8)).toEqual([]);
    expect(computePeaks([new Float32Array(0)], 2)).toEqual([peaks([0, 0], [0, 0])]);
  });

  it('rejects non-positive bucket counts', () => {
    expect(() => computePeaks([new Float32Array(4)], 0)).toThrow(RangeError);
    expect(() => computePeaks([new Float32Array(4)], 1.5)).toThrow(RangeError);
  });
});

describe('computePeaks (wasm delegation)', () => {
  it('delegates to waveformPeaks with interleaved input and splits the report', () => {
    const waveformPeaks = vi.fn(
      (_samples: Float32Array, channels: number, options?: { samplesPerBucket?: number }) => ({
        // Channel-major report: ch0 buckets then ch1 buckets.
        min: new Float32Array([-1, -2, -10, -20]),
        max: new Float32Array([1, 2, 10, 20]),
        channels,
        bucketCount: 2,
        samplesPerBucket: options?.samplesPerBucket ?? 512,
      }),
    );
    const mod: WaveformPeaksModule = { waveformPeaks };
    const channels = [new Float32Array([1, -1, 2, -2]), new Float32Array([10, -10, 20, -20])];
    const result = computePeaks(channels, 2, { wasm: mod });
    expect(result).toEqual([peaks([-1, -2], [1, 2]), peaks([-10, -20], [10, 20])]);
    expect(waveformPeaks).toHaveBeenCalledTimes(1);
    const [samples, channelCount, options] = waveformPeaks.mock.calls[0];
    expect(samples).toEqual(new Float32Array([1, 10, -1, -10, 2, 20, -2, -20]));
    expect(channelCount).toBe(2);
    expect(options).toEqual({ samplesPerBucket: 2, validate: false });
  });

  it('pads a shorter delegate report to the requested bucket count', () => {
    const mod: WaveformPeaksModule = {
      waveformPeaks: () => ({
        min: new Float32Array([-1]),
        max: new Float32Array([1]),
        channels: 1,
        bucketCount: 1,
        samplesPerBucket: 4,
      }),
    };
    expect(computePeaks([new Float32Array([1, -1, 1, -1])], 3, { wasm: mod })).toEqual([
      peaks([-1, 0, 0], [1, 0, 0]),
    ]);
  });

  it('falls back to the pure path when the delegate throws or is absent', () => {
    const throwing: WaveformPeaksModule = {
      waveformPeaks: () => {
        throw new Error('wasm trap');
      },
    };
    const channel = new Float32Array([1, -1]);
    expect(computePeaks([channel], 1, { wasm: throwing })).toEqual([peaks([-1], [1])]);
    expect(computePeaks([channel], 1, { wasm: {} })).toEqual([peaks([-1], [1])]);
    expect(computePeaks([channel], 1, { wasm: null })).toEqual([peaks([-1], [1])]);
  });
});

describe('mergePeaks', () => {
  it('takes the bucket-wise envelope across channels', () => {
    const merged = mergePeaks([peaks([-1, 0], [1, 0]), peaks([0, -2], [0, 2])]);
    expect(merged).toEqual(peaks([-1, -2], [1, 2]));
  });

  it('handles empty input and rejects mismatched bucket counts', () => {
    expect(mergePeaks([])).toEqual(peaks([], []));
    expect(() => mergePeaks([peaks([0], [0]), peaks([0, 0], [0, 0])])).toThrow(RangeError);
  });
});

describe('WaveformPeaksCache', () => {
  it('caches per assetId and bucketCount, returning the same instance', () => {
    const cache = createWaveformPeaksCache();
    const channels = [new Float32Array([1, -1, 2, -2])];
    const first = cache.get('asset-a', channels, 2);
    expect(cache.get('asset-a', channels, 2)).toBe(first);
    expect(cache.get('asset-a', channels, 4)).not.toBe(first);
    expect(cache.get('asset-b', channels, 2)).not.toBe(first);
  });

  it('getMerged caches the merged envelope per zoom level', () => {
    const cache = createWaveformPeaksCache();
    const channels = [new Float32Array([1, -1]), new Float32Array([2, -2])];
    const merged = cache.getMerged('asset-a', channels, 1);
    expect(merged).toEqual(peaks([-2], [2]));
    expect(cache.getMerged('asset-a', channels, 1)).toBe(merged);
  });

  it('invalidate drops only the given asset', () => {
    const cache = createWaveformPeaksCache();
    const channels = [new Float32Array([1, -1])];
    const a = cache.get('asset-a', channels, 1);
    const b = cache.get('asset-b', channels, 1);
    cache.invalidate('asset-a');
    expect(cache.get('asset-a', channels, 1)).not.toBe(a);
    expect(cache.get('asset-b', channels, 1)).toBe(b);
  });

  it('clear drops everything', () => {
    const cache = createWaveformPeaksCache();
    const channels = [new Float32Array([1, -1])];
    const a = cache.get('asset-a', channels, 1);
    cache.clear();
    expect(cache.get('asset-a', channels, 1)).not.toBe(a);
  });
});
