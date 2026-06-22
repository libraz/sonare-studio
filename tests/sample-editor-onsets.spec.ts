import { describe, expect, it } from 'vitest';
import {
  downmixToMono,
  onsetSecondsToFrames,
  silenceSplitMarkers,
  sliceRangeAt,
  snapFrameToOnsets,
} from '@/ui/sample-editor/onsets';

describe('downmixToMono', () => {
  it('returns an empty buffer for no channels', () => {
    expect([...downmixToMono([])]).toEqual([]);
  });

  it('returns a mono channel as-is (no copy needed for the detector)', () => {
    const mono = new Float32Array([0.1, 0.2, 0.3]);
    expect(downmixToMono([mono])).toBe(mono);
  });

  it('averages multiple channels frame by frame', () => {
    const left = new Float32Array([1, 0, -1, 0.5]);
    const right = new Float32Array([0, 1, 1, 0.5]);
    expect([...downmixToMono([left, right])]).toEqual([0.5, 0.5, 0, 0.5]);
  });
});

describe('onsetSecondsToFrames', () => {
  it('rounds to frames and sorts ascending', () => {
    // 48000 Hz: 0.5 s -> 24000, 0.1 s -> 4800, 0.25 s -> 12000.
    expect(onsetSecondsToFrames([0.5, 0.1, 0.25], 48000, 48000)).toEqual([4800, 12000, 24000]);
  });

  it('drops non-finite, negative and out-of-range entries and dedupes', () => {
    expect(onsetSecondsToFrames([Number.NaN, -0.01, 0, 0, 1, 2], 1000, 1500)).toEqual([0, 1000]); // 2 s -> 2000 is >= totalFrames; the duplicate 0 collapses.
  });
});

describe('snapFrameToOnsets', () => {
  const onsets = [100, 500, 900];

  it('snaps to the nearest onset within tolerance', () => {
    expect(snapFrameToOnsets(104, onsets, 6)).toBe(100);
    expect(snapFrameToOnsets(495, onsets, 6)).toBe(500);
  });

  it('leaves the frame unchanged when nothing is within tolerance', () => {
    expect(snapFrameToOnsets(300, onsets, 6)).toBe(300);
  });

  it('keeps the earlier onset on a tie', () => {
    // 300 is 200 from both 100 and 500; with a wide tolerance the earlier wins.
    expect(snapFrameToOnsets(300, onsets, 1000)).toBe(100);
  });

  it('returns the frame unchanged with no onsets', () => {
    expect(snapFrameToOnsets(42, [], 6)).toBe(42);
  });
});

describe('sliceRangeAt', () => {
  const onsets = [100, 500, 900];

  it('returns the slice between the onset at/before the frame and the next', () => {
    expect(sliceRangeAt(300, onsets, 2000)).toEqual({ startFrame: 100, endFrame: 500 });
    expect(sliceRangeAt(500, onsets, 2000)).toEqual({ startFrame: 500, endFrame: 900 });
  });

  it('runs the last slice to the total frame count', () => {
    expect(sliceRangeAt(1500, onsets, 2000)).toEqual({ startFrame: 900, endFrame: 2000 });
  });

  it('returns null before the first onset or when the slice would be empty', () => {
    expect(sliceRangeAt(50, onsets, 2000)).toBeNull();
    expect(sliceRangeAt(900, [900], 900)).toBeNull();
  });
});

describe('silenceSplitMarkers', () => {
  it('keeps the interior cut boundaries of the non-silent intervals, sorted', () => {
    // Two non-silent regions [0, 500] and [900, 2000]; the cuts are 500 and 900.
    const intervals = new Int32Array([0, 500, 900, 2000]);
    expect(silenceSplitMarkers(intervals, 2000)).toEqual([500, 900]);
  });

  it('drops boundaries at 0, at/after the end, non-finite, and dedupes', () => {
    expect(silenceSplitMarkers([0, 0, 100, 100, 2000, Number.NaN, 2500], 2000)).toEqual([100]);
  });

  it('rounds fractional boundaries to whole frames', () => {
    expect(silenceSplitMarkers([10.4, 10.6], 2000)).toEqual([10, 11]);
  });

  it('returns an empty list for no interior cuts', () => {
    expect(silenceSplitMarkers([0, 2000], 2000)).toEqual([]);
    expect(silenceSplitMarkers([], 2000)).toEqual([]);
  });
});
