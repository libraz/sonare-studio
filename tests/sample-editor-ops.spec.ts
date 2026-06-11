import { describe, expect, it } from 'vitest';
import {
  applyGainDb,
  clampRange,
  dbToGain,
  fadeInLinear,
  fadeOutLinear,
  frameCount,
  normalizeToDb,
  peakAmplitude,
  resolveRange,
  reverse,
  silence,
  spliceRange,
  trimToRange,
} from '@/ui/sample-editor/ops';

/** Shorthand: plain number arrays to planar Float32Array channels. */
function ch(...channels: number[][]): Float32Array[] {
  return channels.map((c) => new Float32Array(c));
}

/** Shorthand: planar channels back to plain number arrays. */
function plain(channels: ReadonlyArray<Float32Array>): number[][] {
  return channels.map((c) => [...c]);
}

describe('range helpers', () => {
  it('clampRange floors fractions and clamps into bounds', () => {
    expect(clampRange({ startFrame: 1.9, endFrame: 3.2 }, 10)).toEqual({
      startFrame: 1,
      endFrame: 3,
    });
    expect(clampRange({ startFrame: -5, endFrame: 99 }, 10)).toEqual({
      startFrame: 0,
      endFrame: 10,
    });
  });

  it('clampRange collapses a reversed range to empty at its start', () => {
    expect(clampRange({ startFrame: 6, endFrame: 2 }, 10)).toEqual({ startFrame: 6, endFrame: 6 });
  });

  it('resolveRange defaults to the whole file and clamps a given range', () => {
    const channels = ch([1, 2, 3, 4]);
    expect(resolveRange(channels)).toEqual({ startFrame: 0, endFrame: 4 });
    expect(resolveRange(channels, null)).toEqual({ startFrame: 0, endFrame: 4 });
    expect(resolveRange(channels, { startFrame: 1, endFrame: 99 })).toEqual({
      startFrame: 1,
      endFrame: 4,
    });
    expect(resolveRange([], undefined)).toEqual({ startFrame: 0, endFrame: 0 });
  });

  it('frameCount reads the first channel (0 for no channels)', () => {
    expect(frameCount(ch([1, 2, 3]))).toBe(3);
    expect(frameCount([])).toBe(0);
  });

  it('operations reject mismatched channel lengths', () => {
    const ragged = [new Float32Array(3), new Float32Array(2)];
    expect(() => silence(ragged)).toThrow(RangeError);
    expect(() => applyGainDb(ragged, 0)).toThrow(RangeError);
  });
});

describe('dbToGain', () => {
  it('maps decibels to linear gain', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(20)).toBeCloseTo(10, 10);
    expect(dbToGain(-20)).toBeCloseTo(0.1, 10);
    expect(dbToGain(-6)).toBeCloseTo(0.5012, 3);
  });
});

describe('peakAmplitude', () => {
  it('finds the absolute peak across channels and ranges', () => {
    const channels = ch([0.1, -0.8, 0.2], [0.3, 0.4, -0.5]);
    expect(peakAmplitude(channels)).toBeCloseTo(0.8, 6);
    expect(peakAmplitude(channels, { startFrame: 2, endFrame: 3 })).toBeCloseTo(0.5, 6);
    expect(peakAmplitude([])).toBe(0);
  });
});

describe('applyGainDb', () => {
  it('applies linear gain to the whole file by default', () => {
    const input = ch([0.5, -0.5]);
    const out = applyGainDb(input, 6.0205999); // ~2x
    expect(out[0][0]).toBeCloseTo(1, 5);
    expect(out[0][1]).toBeCloseTo(-1, 5);
  });

  it('only touches the selected range and never mutates the input', () => {
    const input = ch([1, 1, 1, 1]);
    const out = applyGainDb(input, -20, { startFrame: 1, endFrame: 3 });
    expect(out[0][0]).toBe(1);
    expect(out[0][1]).toBeCloseTo(0.1, 6);
    expect(out[0][2]).toBeCloseTo(0.1, 6);
    expect(out[0][3]).toBe(1);
    expect(plain(input)).toEqual([[1, 1, 1, 1]]);
    expect(out[0]).not.toBe(input[0]);
  });

  it('preserves stereo: both channels get the same gain', () => {
    const out = applyGainDb(ch([0.5, 0.5], [0.25, 0.25]), 6.0205999);
    expect(out).toHaveLength(2);
    expect(out[0][0]).toBeCloseTo(1, 5);
    expect(out[1][0]).toBeCloseTo(0.5, 5);
  });

  it('rejects non-finite gain', () => {
    expect(() => applyGainDb(ch([1]), Number.NaN)).toThrow(RangeError);
    expect(() => applyGainDb(ch([1]), Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('normalizeToDb', () => {
  it('scales the peak to the target level', () => {
    const out = normalizeToDb(ch([0.25, -0.5]), 0);
    expect(out[0][0]).toBeCloseTo(0.5, 6);
    expect(out[0][1]).toBeCloseTo(-1, 6);
  });

  it('uses one linked scale factor across channels', () => {
    const out = normalizeToDb(ch([0.5, 0], [0.25, 0]), 0);
    // Peak is 0.5 on channel 0, so the shared gain is 2x.
    expect(out[0][0]).toBeCloseTo(1, 6);
    expect(out[1][0]).toBeCloseTo(0.5, 6);
  });

  it('measures and scales only inside the range', () => {
    const input = ch([1, 0.25, 0.25, 1]);
    const out = normalizeToDb(input, 0, { startFrame: 1, endFrame: 3 });
    expect(out[0][0]).toBe(1); // untouched
    expect(out[0][1]).toBeCloseTo(1, 6); // 0.25 scaled by 4x
    expect(out[0][3]).toBe(1); // untouched
    expect(plain(input)).toEqual([[1, 0.25, 0.25, 1]]);
  });

  it('targets levels below full scale', () => {
    const out = normalizeToDb(ch([0.1]), -6.0205999);
    expect(out[0][0]).toBeCloseTo(0.5, 5);
  });

  it('returns silence unchanged and rejects non-finite targets', () => {
    expect(plain(normalizeToDb(ch([0, 0]), -1))).toEqual([[0, 0]]);
    expect(() => normalizeToDb(ch([1]), Number.NaN)).toThrow(RangeError);
  });
});

describe('fades', () => {
  it('fadeInLinear ramps from silence to original level', () => {
    const out = fadeInLinear(ch([1, 1, 1, 1, 1]));
    expect(plain(out)).toEqual([[0, 0.25, 0.5, 0.75, 1]]);
  });

  it('fadeOutLinear ramps from original level to silence', () => {
    const out = fadeOutLinear(ch([1, 1, 1, 1, 1]));
    expect(plain(out)).toEqual([[1, 0.75, 0.5, 0.25, 0]]);
  });

  it('fades only the selected range', () => {
    const input = ch([1, 1, 1, 1, 1]);
    const out = fadeInLinear(input, { startFrame: 2, endFrame: 5 });
    expect(plain(out)).toEqual([[1, 1, 0, 0.5, 1]]);
    expect(plain(input)).toEqual([[1, 1, 1, 1, 1]]);
  });

  it('a single-frame fade silences that frame', () => {
    expect(plain(fadeInLinear(ch([1]), { startFrame: 0, endFrame: 1 }))).toEqual([[0]]);
    expect(plain(fadeOutLinear(ch([1]), { startFrame: 0, endFrame: 1 }))).toEqual([[0]]);
  });

  it('applies the same ramp to every channel', () => {
    const out = fadeOutLinear(ch([1, 1, 1], [0.5, 0.5, 0.5]));
    expect(plain(out)).toEqual([
      [1, 0.5, 0],
      [0.5, 0.25, 0],
    ]);
  });
});

describe('reverse', () => {
  it('reverses the whole file by default', () => {
    expect(plain(reverse(ch([1, 2, 3, 4])))).toEqual([[4, 3, 2, 1]]);
  });

  it('reverses only the range and each channel independently', () => {
    const input = ch([1, 2, 3, 4, 5], [9, 8, 7, 6, 5]);
    const out = reverse(input, { startFrame: 1, endFrame: 4 });
    expect(plain(out)).toEqual([
      [1, 4, 3, 2, 5],
      [9, 6, 7, 8, 5],
    ]);
    expect(plain(input)).toEqual([
      [1, 2, 3, 4, 5],
      [9, 8, 7, 6, 5],
    ]);
  });
});

describe('silence', () => {
  it('zeroes only the range', () => {
    const input = ch([1, 2, 3, 4]);
    expect(plain(silence(input, { startFrame: 1, endFrame: 3 }))).toEqual([[1, 0, 0, 4]]);
    expect(plain(silence(input))).toEqual([[0, 0, 0, 0]]);
    expect(plain(input)).toEqual([[1, 2, 3, 4]]);
  });
});

describe('trimToRange', () => {
  it('crops to the range on all channels', () => {
    const input = ch([1, 2, 3, 4], [5, 6, 7, 8]);
    expect(plain(trimToRange(input, { startFrame: 1, endFrame: 3 }))).toEqual([
      [2, 3],
      [6, 7],
    ]);
    expect(plain(input)).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
  });

  it('clamps out-of-bounds ranges', () => {
    expect(plain(trimToRange(ch([1, 2, 3]), { startFrame: -4, endFrame: 99 }))).toEqual([
      [1, 2, 3],
    ]);
  });

  it('rejects empty (or fully out-of-range) ranges', () => {
    expect(() => trimToRange(ch([1, 2]), { startFrame: 1, endFrame: 1 })).toThrow(RangeError);
    expect(() => trimToRange(ch([1, 2]), { startFrame: 5, endFrame: 9 })).toThrow(RangeError);
  });
});

describe('spliceRange', () => {
  it('replaces the range with a segment of a different length', () => {
    const input = ch([1, 2, 3, 4]);
    const out = spliceRange(input, { startFrame: 1, endFrame: 3 }, ch([9, 9, 9]));
    expect(plain(out)).toEqual([[1, 9, 9, 9, 4]]);
    expect(plain(input)).toEqual([[1, 2, 3, 4]]);
  });

  it('handles stereo and shrinking replacements', () => {
    const out = spliceRange(
      ch([1, 2, 3, 4], [5, 6, 7, 8]),
      { startFrame: 0, endFrame: 3 },
      ch([0], [9]),
    );
    expect(plain(out)).toEqual([
      [0, 4],
      [9, 8],
    ]);
  });

  it('rejects channel-count and segment-length mismatches', () => {
    const stereo = ch([1, 2], [3, 4]);
    expect(() => spliceRange(stereo, { startFrame: 0, endFrame: 1 }, ch([0]))).toThrow(RangeError);
    expect(() =>
      spliceRange(stereo, { startFrame: 0, endFrame: 1 }, [
        new Float32Array(2),
        new Float32Array(3),
      ]),
    ).toThrow(RangeError);
  });
});
