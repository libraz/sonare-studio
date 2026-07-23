import { describe, expect, it } from 'vitest';
import {
  loopRecordingSplits,
  loopRecordingTakeSlices,
  nativeLoopRecordingDesc,
  snapLoopRecordingStartPpq,
} from '@/project/loop-recording';

describe('loopRecordingSplits', () => {
  it('returns complete loop passes and ignores overhang', () => {
    expect(loopRecordingSplits(250, 100)).toEqual([
      { index: 0, startFrame: 0, endFrame: 100 },
      { index: 1, startFrame: 100, endFrame: 200 },
    ]);
  });

  it('anchors rounded boundaries instead of accumulating frame drift', () => {
    expect(loopRecordingSplits(31, 10.4)).toEqual([
      { index: 0, startFrame: 0, endFrame: 10 },
      { index: 1, startFrame: 10, endFrame: 21 },
    ]);
  });

  it('keeps short or invalid captures as one linear take', () => {
    expect(loopRecordingSplits(150, 100)).toEqual([]);
    expect(loopRecordingSplits(0, 100)).toEqual([]);
    expect(loopRecordingSplits(100, 0)).toEqual([]);
    expect(loopRecordingSplits(Number.NaN, 100)).toEqual([]);
  });
});

describe('snapLoopRecordingStartPpq', () => {
  const loop = { loopEnabled: true, loopStartPpq: 8, loopEndPpq: 12 };

  it('aligns stopped non-explicit recording near the cycle start', () => {
    expect(snapLoopRecordingStartPpq(8.4, { ...loop, explicit: false, wasRolling: false })).toBe(8);
  });

  it('keeps rolling, explicit, distant, and invalid-loop starts unchanged', () => {
    expect(snapLoopRecordingStartPpq(8.4, { ...loop, explicit: true, wasRolling: false })).toBe(
      8.4,
    );
    expect(snapLoopRecordingStartPpq(8.4, { ...loop, explicit: false, wasRolling: true })).toBe(
      8.4,
    );
    expect(snapLoopRecordingStartPpq(8.5, { ...loop, explicit: false, wasRolling: false })).toBe(
      8.5,
    );
    expect(
      snapLoopRecordingStartPpq(8.1, {
        ...loop,
        explicit: false,
        wasRolling: false,
        loopEndPpq: 8,
      }),
    ).toBe(8.1);
  });
});

describe('loopRecordingTakeSlices', () => {
  it('slices every completed pass across planar channels', () => {
    const takes = loopRecordingTakeSlices(
      [new Float32Array([1, 2, 3, 4]), new Float32Array([10, 20, 30, 40])],
      [
        { index: 0, startFrame: 0, endFrame: 2 },
        { index: 1, startFrame: 2, endFrame: 4 },
      ],
    );

    expect(takes).toHaveLength(2);
    expect(takes[0].index).toBe(0);
    expect(takes[0].channels.map((channel) => [...channel])).toEqual([
      [1, 2],
      [10, 20],
    ]);
    expect(takes[1].channels.map((channel) => [...channel])).toEqual([
      [3, 4],
      [30, 40],
    ]);
  });

  it('clips slices to the shortest channel and skips invalid passes', () => {
    const takes = loopRecordingTakeSlices(
      [new Float32Array([1, 2, 3, 4]), new Float32Array([10, 20, 30])],
      [
        { index: 0, startFrame: 0, endFrame: 2 },
        { index: 1, startFrame: 2, endFrame: 4 },
        { index: 2, startFrame: 4, endFrame: 4 },
      ],
    );

    expect(takes).toHaveLength(2);
    expect(takes[1].channels.map((channel) => [...channel])).toEqual([[3], [30]]);
  });

  it('returns no take slices for empty channels or split lists', () => {
    expect(loopRecordingTakeSlices([], [{ index: 0, startFrame: 0, endFrame: 1 }])).toEqual([]);
    expect(loopRecordingTakeSlices([new Float32Array([1])], [])).toEqual([]);
    expect(
      loopRecordingTakeSlices([new Float32Array()], [{ index: 0, startFrame: 0, endFrame: 1 }]),
    ).toEqual([]);
  });
});

describe('nativeLoopRecordingDesc', () => {
  it('builds the interleaved descriptor expected by Project.addLoopRecordingTakes', () => {
    const desc = nativeLoopRecordingDesc(
      7,
      [new Float32Array([1, 2, 3]), new Float32Array([10, 20, 30])],
      48000,
      4,
      8,
    );

    expect(desc).toMatchObject({
      trackId: 7,
      startPpq: 4,
      loopLengthPpq: 8,
      audioChannels: 2,
      audioSampleRate: 48000,
    });
    expect([...(desc?.audio ?? [])]).toEqual([1, 10, 2, 20, 3, 30]);
  });

  it('clips native descriptor audio to the shortest returned capture channel', () => {
    const desc = nativeLoopRecordingDesc(
      1,
      [new Float32Array([1, 2, 3, 4]), new Float32Array([10, 20])],
      44100,
      0,
      4,
    );

    expect(desc?.audioChannels).toBe(2);
    expect([...(desc?.audio ?? [])]).toEqual([1, 10, 2, 20]);
  });

  it('rejects invalid native descriptor inputs', () => {
    expect(nativeLoopRecordingDesc(1, [], 48000, 0, 4)).toBeNull();
    expect(nativeLoopRecordingDesc(1, [new Float32Array()], 48000, 0, 4)).toBeNull();
    expect(nativeLoopRecordingDesc(1, [new Float32Array([1])], 0, 0, 4)).toBeNull();
    expect(nativeLoopRecordingDesc(1, [new Float32Array([1])], 48000, -1, 4)).toBeNull();
    expect(nativeLoopRecordingDesc(1, [new Float32Array([1])], 48000, 0, 0)).toBeNull();
  });
});
