import type { WaveformPeaksReport, WaveformPeaksRequest } from '@libraz/libsonare';
import * as core from '@libraz/libsonare';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type ChannelPeaks,
  computePeaks,
  computeWindowPeaks,
  createWaveformPeaksCache,
  mergePeaks,
  type WaveformPeaksModule,
} from '@/ui/waveform/peaks';
import { coreWasmBinary } from './core-package';
import { waveformPeaksReport } from './fakes/analysis';

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

/** A core `waveformPeaks` double that scans like the real one: ceil(frames / width) buckets. */
function scanningWaveformPeaks(request: WaveformPeaksRequest): WaveformPeaksReport {
  const width = request.samplesPerBucket ?? 512;
  const frames = request.channels[0]?.length ?? 0;
  const bucketCount = Math.ceil(frames / width);
  const min = request.channels.map(() => new Float32Array(bucketCount));
  const max = request.channels.map(() => new Float32Array(bucketCount));
  request.channels.forEach((channel, c) => {
    for (let b = 0; b < bucketCount; b++) {
      const bucket = channel.subarray(b * width, Math.min(frames, (b + 1) * width));
      min[c][b] = Math.min(...bucket);
      max[c][b] = Math.max(...bucket);
    }
  });
  return { min, max, bucketCount, samplesPerBucket: width };
}

describe('computePeaks (wasm delegation)', () => {
  it('delegates to waveformPeaks with planar channels and reads the per-channel report', () => {
    const waveformPeaks = vi.fn(scanningWaveformPeaks);
    const mod: WaveformPeaksModule = { waveformPeaks };
    const channels = [new Float32Array([1, -1, 2, -2]), new Float32Array([10, -10, 20, -20])];
    const result = computePeaks(channels, 2, { wasm: mod });
    expect(result).toEqual([peaks([-1, -2], [1, 2]), peaks([-10, -20], [10, 20])]);
    expect(waveformPeaks).toHaveBeenCalledTimes(1);
    expect(waveformPeaks).toHaveBeenCalledWith({ channels, samplesPerBucket: 2 });
  });

  it('falls back when a shorter delegate report would leave blank tail buckets', () => {
    const mod: WaveformPeaksModule = {
      waveformPeaks: () =>
        waveformPeaksReport({
          min: [new Float32Array([-1])],
          max: [new Float32Array([1])],
          bucketCount: 1,
          samplesPerBucket: 4,
        }),
    };
    expect(computePeaks([new Float32Array([1, -1, 1, -1])], 3, { wasm: mod })).toEqual([
      peaks([1, -1, -1], [1, -1, 1]),
    ]);
  });

  it('skips the delegate when sparse audio cannot fill the requested bucket count', () => {
    const waveformPeaks = vi.fn(scanningWaveformPeaks);
    const channel = new Float32Array([1, -1]);

    expect(computePeaks([channel], 4, { wasm: { waveformPeaks } })).toEqual([
      peaks([0, 1, 0, -1], [0, 1, 0, -1]),
    ]);
    expect(waveformPeaks).not.toHaveBeenCalled();
  });

  it('keeps the tail of the asset when the delegate overshoots the request', () => {
    // The real delegate derives bucketCount = ceil(frames / samplesPerBucket)
    // from an integer bucket width, so it reports more buckets than asked for
    // whenever the width does not divide the frame count. Only the last bucket
    // is loud here: taking a prefix of the report would render the end of the
    // asset as silence and stretch everything before it.
    const frames = 100;
    const channel = new Float32Array(frames);
    channel[frames - 1] = 1;

    // 100 frames over 30 buckets: width floors to 3, so the delegate reports
    // 34 buckets and the loud one is past a 30-bucket prefix.
    const result = computePeaks([channel], 30, { wasm: { waveformPeaks: scanningWaveformPeaks } });
    expect(result[0].max).toHaveLength(30);
    expect(result[0].max[29]).toBe(1);
    expect(Array.from(result[0].max.subarray(0, 29))).toEqual(Array(29).fill(0));
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

  it('reduces a coarser zoom level from a cached finer one', () => {
    const scan = vi.fn();
    const counting: WaveformPeaksModule = {
      waveformPeaks: (request) => {
        scan();
        return scanningWaveformPeaks(request);
      },
    };
    const cache = createWaveformPeaksCache({ wasm: counting });
    const frames = 256;
    const channel = new Float32Array(frames);
    for (let i = 0; i < frames; i++) channel[i] = i % 2 === 0 ? i / frames : -i / frames;

    const fine = cache.get('asset-a', [channel], 64);
    expect(scan).toHaveBeenCalledTimes(1);

    // Zooming out reuses the scan already paid for instead of walking every
    // sample again; the envelope still covers the whole asset.
    const coarse = cache.get('asset-a', [channel], 16);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(coarse[0].max).toHaveLength(16);
    expect(coarse[0].max[15]).toBeCloseTo(fine[0].max[63], 5);
    expect(coarse[0].min[15]).toBeCloseTo(Math.min(...fine[0].min.subarray(60, 64)), 5);

    // A finer level than anything cached still has to scan.
    cache.get('asset-a', [channel], 128);
    expect(scan).toHaveBeenCalledTimes(2);
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

describe('computeWindowPeaks', () => {
  /** Deterministic noise with sparse spikes, so block extremes sit at arbitrary frames. */
  function signal(frames: number, seed: number): Float32Array {
    const out = new Float32Array(frames);
    let state = seed;
    for (let i = 0; i < frames; i++) {
      state = (state * 1103515245 + 12345) % 2147483648;
      const noise = state / 2147483648 - 0.5;
      out[i] = i % 997 === 0 ? noise * 4 : noise;
    }
    return out;
  }

  const ASSET_FRAMES = 256 * 400 + 37;
  const STARTS = { zero: 0, blockAligned: 256 * 7, unaligned: 1801 } as const;
  const ENDS = { assetEnd: ASSET_FRAMES, blockAligned: 256 * 390, unaligned: 99_001 } as const;
  /** Bucket counts by frames per bucket relative to the two-block threshold. */
  const BUCKETS = {
    below: (frames: number) => Math.ceil(frames / 300),
    atThreshold: (frames: number) => Math.floor(frames / 512),
    large: () => 37,
    nonInteger: () => 113,
  } as const;
  // Pairwise over window start/end alignment, bucket span and channel count.
  const CASES: Array<[keyof typeof STARTS, keyof typeof ENDS, keyof typeof BUCKETS, number]> = [
    ['unaligned', 'blockAligned', 'atThreshold', 1],
    ['zero', 'blockAligned', 'below', 2],
    ['zero', 'assetEnd', 'atThreshold', 2],
    ['unaligned', 'unaligned', 'below', 1],
    ['blockAligned', 'unaligned', 'nonInteger', 2],
    ['zero', 'blockAligned', 'nonInteger', 1],
    ['blockAligned', 'assetEnd', 'large', 1],
    ['unaligned', 'assetEnd', 'nonInteger', 2],
    ['zero', 'unaligned', 'large', 2],
    ['unaligned', 'blockAligned', 'large', 2],
    ['blockAligned', 'blockAligned', 'below', 1],
    ['unaligned', 'assetEnd', 'below', 1],
    ['blockAligned', 'unaligned', 'atThreshold', 1],
  ];

  it.each(CASES)('matches a full scan (start %s, end %s, buckets %s, %i ch)', (s, e, b, ch) => {
    const channels = Array.from({ length: ch }, (_, c) => signal(ASSET_FRAMES, 7 + c));
    const start = STARTS[s];
    const end = ENDS[e];
    const bucketCount = BUCKETS[b](end - start);
    const expected = computePeaks(
      channels.map((channel) => channel.subarray(start, end)),
      bucketCount,
    );
    expect(computeWindowPeaks(channels, start, end, bucketCount)).toEqual(expected);
  });
});

describe('computePeaks against the real core', () => {
  beforeAll(async () => {
    await core.init({ wasmBinary: coreWasmBinary() });
  });

  it('matches the pure path bucket for bucket', () => {
    const channels = [
      Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 7)),
      Float32Array.from({ length: 1000 }, (_, i) => Math.cos(i / 11) * 0.5),
    ];
    const waveformPeaks = vi.fn(core.waveformPeaks);
    const viaCore = computePeaks(channels, 100, { wasm: { waveformPeaks } });
    expect(waveformPeaks).toHaveBeenCalledOnce();
    const pure = computePeaks(channels, 100);
    expect(viaCore).toHaveLength(2);
    viaCore.forEach((channel, c) => {
      expect(channel.min).toHaveLength(100);
      expect(Array.from(channel.min)).toEqual(Array.from(pure[c].min));
      expect(Array.from(channel.max)).toEqual(Array.from(pure[c].max));
    });
  });
});
