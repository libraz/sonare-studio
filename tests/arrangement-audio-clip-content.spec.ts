import { describe, expect, it } from 'vitest';
import {
  assetLengthPpq,
  audioClipSourceBounds,
  audioWindowFractions,
  PEAK_BUCKETS_PER_SECOND_LEVELS,
  peaksBucketCount,
  peaksBucketsPerSecond,
  waveformColumns,
} from '@/ui/arrangement/audio-clip-content';

const peaks = (min: number[], max: number[]) => ({
  min: Float32Array.from(min),
  max: Float32Array.from(max),
});

describe('peaksBucketsPerSecond', () => {
  it('picks the smallest level at or above the zoom', () => {
    expect(peaksBucketsPerSecond(0)).toBe(PEAK_BUCKETS_PER_SECOND_LEVELS[0]);
    expect(peaksBucketsPerSecond(4)).toBe(4);
    expect(peaksBucketsPerSecond(4.01)).toBe(16);
    expect(peaksBucketsPerSecond(100)).toBe(256);
  });

  it('clamps to the finest level when the zoom exceeds all levels', () => {
    const finest = PEAK_BUCKETS_PER_SECOND_LEVELS[PEAK_BUCKETS_PER_SECOND_LEVELS.length - 1];
    expect(peaksBucketsPerSecond(finest + 1)).toBe(finest);
    expect(peaksBucketsPerSecond(1e9)).toBe(finest);
  });
});

describe('peaksBucketCount', () => {
  it('covers the asset duration at the requested level', () => {
    expect(peaksBucketCount(48000, 48000, 4)).toBe(4);
    expect(peaksBucketCount(72000, 48000, 4)).toBe(6);
  });

  it('rounds partial buckets up and never returns less than one', () => {
    expect(peaksBucketCount(1000, 48000, 4)).toBe(1);
    expect(peaksBucketCount(49000, 48000, 4)).toBe(5);
  });

  it('never returns more buckets than frames', () => {
    expect(peaksBucketCount(2, 1, 1024)).toBe(2);
  });

  it('returns one bucket for degenerate inputs', () => {
    expect(peaksBucketCount(0, 48000, 4)).toBe(1);
    expect(peaksBucketCount(48000, 0, 4)).toBe(1);
    expect(peaksBucketCount(48000, 48000, 0)).toBe(1);
  });
});

describe('assetLengthPpq', () => {
  it('converts asset frames to PPQ at a constant tempo', () => {
    // One second at 120 BPM = 2 quarter notes.
    expect(assetLengthPpq(48000, 48000, 120)).toBe(2);
    expect(assetLengthPpq(24000, 48000, 60)).toBe(0.5);
  });

  it('returns zero for degenerate inputs', () => {
    expect(assetLengthPpq(0, 48000, 120)).toBe(0);
    expect(assetLengthPpq(48000, 0, 120)).toBe(0);
    expect(assetLengthPpq(48000, 48000, 0)).toBe(0);
  });
});

describe('audioWindowFractions', () => {
  it('maps the source window onto asset duration fractions', () => {
    // 48000 frames at 48 kHz and 120 BPM = 2 PPQ of source audio.
    const window = audioWindowFractions(1, 1, 120, 48000, 48000);
    expect(window.startFrac).toBeCloseTo(0.5);
    expect(window.endFrac).toBeCloseTo(1);
  });

  it('does not clamp a window extending past the asset end', () => {
    const window = audioWindowFractions(1, 3, 120, 48000, 48000);
    expect(window.startFrac).toBeCloseTo(0.5);
    expect(window.endFrac).toBeCloseTo(2);
  });

  it('returns a zero window for degenerate inputs', () => {
    expect(audioWindowFractions(0, 0, 120, 48000, 48000)).toEqual({ startFrac: 0, endFrac: 0 });
    expect(audioWindowFractions(0, 4, 120, 0, 48000)).toEqual({ startFrac: 0, endFrac: 0 });
  });
});

describe('waveformColumns', () => {
  it('maps buckets one-to-one when columns match the window buckets', () => {
    const columns = waveformColumns(peaks([-1, -0.5], [1, 0.5]), 0, 1, 2);
    expect(columns).toEqual([
      { min: -1, max: 1 },
      { min: -0.5, max: 0.5 },
    ]);
  });

  it('aggregates the min/max of every bucket a column overlaps', () => {
    expect(waveformColumns(peaks([-1, -0.5], [0.25, 0.5]), 0, 1, 1)).toEqual([
      { min: -1, max: 0.5 },
    ]);
  });

  it('repeats a bucket across sub-bucket columns', () => {
    expect(waveformColumns(peaks([-1, -0.5], [1, 0.5]), 0, 1, 4)).toEqual([
      { min: -1, max: 1 },
      { min: -1, max: 1 },
      { min: -0.5, max: 0.5 },
      { min: -0.5, max: 0.5 },
    ]);
  });

  it('renders the part of the window past the asset end as silence', () => {
    expect(waveformColumns(peaks([-1, -0.5], [1, 0.5]), 0.5, 1.5, 2)).toEqual([
      { min: -0.5, max: 0.5 },
      { min: 0, max: 0 },
    ]);
  });

  it('renders a window entirely outside the asset as silence', () => {
    expect(waveformColumns(peaks([-1], [1]), 2, 3, 2)).toEqual([
      { min: 0, max: 0 },
      { min: 0, max: 0 },
    ]);
  });

  it('returns nothing for degenerate inputs', () => {
    expect(waveformColumns(peaks([-1], [1]), 0, 1, 0)).toEqual([]);
    expect(waveformColumns(peaks([-1], [1]), 1, 1, 4)).toEqual([]);
    expect(waveformColumns(peaks([], []), 0, 1, 4)).toEqual([]);
  });
});

describe('audioClipSourceBounds', () => {
  it('bounds the start at source offset zero and the end at the asset end', () => {
    const bounds = audioClipSourceBounds({ startPpq: 8, sourceOffsetPpq: 2 }, 16);
    expect(bounds.minStartPpq).toBe(6);
    expect(bounds.maxEndPpq).toBe(22);
  });

  it('keeps the start bound on the timeline (never negative)', () => {
    const bounds = audioClipSourceBounds({ startPpq: 1, sourceOffsetPpq: 2 }, 16);
    expect(bounds.minStartPpq).toBe(0);
    expect(bounds.maxEndPpq).toBe(15);
  });
});
