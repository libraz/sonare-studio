import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WarpAnchor } from '@/project/types';
import {
  bakeWarpedClip,
  clearWarpBakeCache,
  type StretchFn,
  sanitizeWarpAnchors,
  type WarpableClipFields,
  warpSegments,
} from '@/project/warp';

/** Builds a warp-enabled clip with overridable fields. */
function makeWarpClip(overrides: Partial<WarpableClipFields> = {}): WarpableClipFields {
  return {
    lengthPpq: 4,
    sourceOffsetPpq: 0,
    warp: { enabled: true, sourceBpm: 60 },
    ...overrides,
  };
}

/** Index ramp (channel[i] = i) so positions are observable in baked output. */
function ramp(frames: number): Float32Array {
  const channel = new Float32Array(frames);
  for (let i = 0; i < frames; i++) channel[i] = i;
  return channel;
}

/**
 * Deterministic fake stretch: nearest-neighbour decimation/expansion with
 * output length = round(input length / rate), wrapped in a spy.
 */
function makeFakeStretch(): StretchFn & ReturnType<typeof vi.fn> {
  return vi.fn((samples: Float32Array, _sampleRate: number, rate: number): Float32Array => {
    const frames = Math.max(1, Math.round(samples.length / rate));
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      out[i] = samples[Math.min(samples.length - 1, Math.round(i * rate))];
    }
    return out;
  }) as StretchFn & ReturnType<typeof vi.fn>;
}

describe('sanitizeWarpAnchors', () => {
  it('keeps valid anchors and sorts them by beat position', () => {
    const anchors: WarpAnchor[] = [
      { ppq: 6, sourceSeconds: 3 },
      { ppq: 2, sourceSeconds: 1 },
    ];
    expect(sanitizeWarpAnchors(anchors, 8)).toEqual([
      { ppq: 2, sourceSeconds: 1 },
      { ppq: 6, sourceSeconds: 3 },
    ]);
  });

  it('returns copies, not the caller objects', () => {
    const anchor: WarpAnchor = { ppq: 2, sourceSeconds: 1 };
    const result = sanitizeWarpAnchors([anchor], 8);
    expect(result[0]).toEqual(anchor);
    expect(result[0]).not.toBe(anchor);
  });

  it('drops non-finite, edge and non-positive entries', () => {
    const invalid: WarpAnchor[] = [
      { ppq: Number.NaN, sourceSeconds: 1 },
      { ppq: Number.POSITIVE_INFINITY, sourceSeconds: 1 },
      { ppq: 0, sourceSeconds: 1 }, // window start is an implicit anchor
      { ppq: 8, sourceSeconds: 1 }, // window end is an implicit anchor
      { ppq: -1, sourceSeconds: 1 },
      { ppq: 2, sourceSeconds: 0 },
      { ppq: 2, sourceSeconds: -2 },
      { ppq: 2, sourceSeconds: Number.NaN },
    ];
    expect(sanitizeWarpAnchors(invalid, 8)).toEqual([]);
  });

  it('drops anchors that do not strictly increase after sorting', () => {
    // Equal beat positions: the first sorted entry wins.
    expect(
      sanitizeWarpAnchors(
        [
          { ppq: 2, sourceSeconds: 1 },
          { ppq: 2, sourceSeconds: 2 },
        ],
        8,
      ),
    ).toEqual([{ ppq: 2, sourceSeconds: 1 }]);
    // Equal source times: the later anchor would freeze time, so it drops.
    expect(
      sanitizeWarpAnchors(
        [
          { ppq: 2, sourceSeconds: 1 },
          { ppq: 4, sourceSeconds: 1 },
        ],
        8,
      ),
    ).toEqual([{ ppq: 2, sourceSeconds: 1 }]);
    // Decreasing source times drop too.
    expect(
      sanitizeWarpAnchors(
        [
          { ppq: 2, sourceSeconds: 2 },
          { ppq: 4, sourceSeconds: 1 },
        ],
        8,
      ),
    ).toEqual([{ ppq: 2, sourceSeconds: 2 }]);
  });

  it('returns [] for empty input', () => {
    expect(sanitizeWarpAnchors([], 8)).toEqual([]);
  });
});

describe('warpSegments', () => {
  it('returns [] without warp, when disabled, or with invalid fields', () => {
    expect(warpSegments({ lengthPpq: 4, sourceOffsetPpq: 0 })).toEqual([]);
    expect(warpSegments(makeWarpClip({ warp: { enabled: false, sourceBpm: 60 } }))).toEqual([]);
    expect(warpSegments(makeWarpClip({ warp: { enabled: true, sourceBpm: 0 } }))).toEqual([]);
    expect(warpSegments(makeWarpClip({ warp: { enabled: true, sourceBpm: Number.NaN } }))).toEqual(
      [],
    );
    expect(warpSegments(makeWarpClip({ lengthPpq: 0 }))).toEqual([]);
  });

  it('forms one segment from the implicit edge anchors', () => {
    // sourceBpm 120: 0.5 s per source PPQ. Offset 2 PPQ = 1 s into the source.
    const clip = makeWarpClip({
      lengthPpq: 4,
      sourceOffsetPpq: 2,
      warp: { enabled: true, sourceBpm: 120 },
    });
    expect(warpSegments(clip)).toEqual([
      { ppq: 0, lengthPpq: 4, sourceStartSeconds: 1, sourceLengthSeconds: 2 },
    ]);
  });

  it('bends the mapping at user anchors (source-relative to the clip start)', () => {
    const clip = makeWarpClip({
      lengthPpq: 4,
      sourceOffsetPpq: 2,
      warp: {
        enabled: true,
        sourceBpm: 120,
        anchors: [{ ppq: 2, sourceSeconds: 0.5 }],
      },
    });
    expect(warpSegments(clip)).toEqual([
      { ppq: 0, lengthPpq: 2, sourceStartSeconds: 1, sourceLengthSeconds: 0.5 },
      { ppq: 2, lengthPpq: 2, sourceStartSeconds: 1.5, sourceLengthSeconds: 1.5 },
    ]);
  });

  it('ignores anchors outside the clip window', () => {
    const clip = makeWarpClip({
      warp: {
        enabled: true,
        sourceBpm: 60,
        anchors: [
          { ppq: 99, sourceSeconds: 1 },
          { ppq: -1, sourceSeconds: 1 },
        ],
      },
    });
    expect(warpSegments(clip)).toEqual([
      { ppq: 0, lengthPpq: 4, sourceStartSeconds: 0, sourceLengthSeconds: 4 },
    ]);
  });

  it('drops degenerate segments (non-increasing source spans)', () => {
    // Anchor maps beat 2 past the clip-end source time (4 s at 60 BPM):
    // the trailing segment would run backwards in the source and drops.
    const backwards = makeWarpClip({
      warp: { enabled: true, sourceBpm: 60, anchors: [{ ppq: 2, sourceSeconds: 5 }] },
    });
    expect(warpSegments(backwards)).toEqual([
      { ppq: 0, lengthPpq: 2, sourceStartSeconds: 0, sourceLengthSeconds: 5 },
    ]);
    // Anchor exactly at the clip-end source time: zero-length tail drops.
    const frozen = makeWarpClip({
      warp: { enabled: true, sourceBpm: 60, anchors: [{ ppq: 2, sourceSeconds: 4 }] },
    });
    expect(warpSegments(frozen)).toEqual([
      { ppq: 0, lengthPpq: 2, sourceStartSeconds: 0, sourceLengthSeconds: 4 },
    ]);
  });
});

describe('bakeWarpedClip', () => {
  beforeEach(() => {
    clearWarpBakeCache();
  });

  it('returns [] for disabled/invalid warp and for empty channels', async () => {
    const stretch = makeFakeStretch();
    expect(
      await bakeWarpedClip([ramp(40)], 10, { lengthPpq: 4, sourceOffsetPpq: 0 }, 120, { stretch }),
    ).toEqual([]);
    expect(
      await bakeWarpedClip(
        [ramp(40)],
        10,
        makeWarpClip({ warp: { enabled: false, sourceBpm: 60 } }),
        120,
        { stretch },
      ),
    ).toEqual([]);
    expect(await bakeWarpedClip([], 10, makeWarpClip(), 120, { stretch })).toEqual([]);
    expect(stretch).not.toHaveBeenCalled();
  });

  it('outputs exactly the clip window at the target tempo via the stretch', async () => {
    // 4 PPQ at sourceBpm 60 = 4 s of source = 40 frames at 10 Hz; the same
    // 4 PPQ at 120 BPM = 2 s = 20 output frames, so the rate is 2.
    const stretch = makeFakeStretch();
    const baked = await bakeWarpedClip([ramp(40)], 10, makeWarpClip(), 120, { stretch });

    expect(baked).toHaveLength(1);
    expect(baked[0].length).toBe((4 * 60 * 10) / 120);
    expect(stretch).toHaveBeenCalledTimes(1);
    const [samples, sampleRate, rate] = stretch.mock.calls[0] as [Float32Array, number, number];
    expect(samples.length).toBe(40);
    expect(sampleRate).toBe(10);
    expect(rate).toBeCloseTo(2, 10);
    // Fake decimation: output frame i reads source frame 2i.
    expect(Array.from(baked[0])).toEqual(Array.from({ length: 20 }, (_, i) => 2 * i));
  });

  it('places segments at their target offsets and bypasses rate-1 segments', async () => {
    // Anchor at beat 2 -> 1 s: segment A maps 2 PPQ (1 s at 120 BPM) onto
    // 1 s of source (rate 1, copied), segment B maps 2 PPQ onto 3 s (rate 3).
    const stretch = makeFakeStretch();
    const clip = makeWarpClip({
      warp: { enabled: true, sourceBpm: 60, anchors: [{ ppq: 2, sourceSeconds: 1 }] },
    });
    const baked = await bakeWarpedClip([ramp(40)], 10, clip, 120, { stretch });

    expect(baked[0].length).toBe(20);
    // Only the rate-3 segment hit the stretch.
    expect(stretch).toHaveBeenCalledTimes(1);
    const [samples, , rate] = stretch.mock.calls[0] as [Float32Array, number, number];
    expect(samples.length).toBe(30);
    expect(rate).toBeCloseTo(3, 10);
    // Segment A: frames 0..9 copied verbatim from source frames 0..9.
    expect(Array.from(baked[0].subarray(0, 10))).toEqual(Array.from({ length: 10 }, (_, i) => i));
    // Segment B: frames 10..19 decimated from source frames 10..39 (10 + 3i).
    expect(Array.from(baked[0].subarray(10, 20))).toEqual(
      Array.from({ length: 10 }, (_, i) => 10 + 3 * i),
    );
  });

  it('clamps an over-long source span to the asset end', async () => {
    // The clip wants 4 s of source (40 frames) but the asset has 15: the
    // segment clamps and the stretch rate compensates (15 source frames
    // spread over the 20 target frames).
    const stretch = makeFakeStretch();
    const baked = await bakeWarpedClip([ramp(15)], 10, makeWarpClip(), 120, { stretch });

    expect(baked[0].length).toBe(20);
    expect(stretch).toHaveBeenCalledTimes(1);
    const [samples, , rate] = stretch.mock.calls[0] as [Float32Array, number, number];
    expect(samples.length).toBe(15);
    expect(rate).toBeCloseTo(15 / 20, 10);
  });

  it('leaves silence (full window length) when the source starts past the asset', async () => {
    const stretch = makeFakeStretch();
    const clip = makeWarpClip({ sourceOffsetPpq: 100 }); // 100 s into a 1.5 s asset
    const baked = await bakeWarpedClip([ramp(15)], 10, clip, 120, { stretch });

    expect(stretch).not.toHaveBeenCalled();
    expect(baked).toHaveLength(1);
    expect(baked[0].length).toBe(20);
    expect(baked[0].every((sample) => sample === 0)).toBe(true);
  });

  it('bakes every channel', async () => {
    const stretch = makeFakeStretch();
    const left = ramp(40);
    const right = ramp(40).map((v) => v + 100);
    const baked = await bakeWarpedClip([left, right], 10, makeWarpClip(), 120, { stretch });

    expect(baked).toHaveLength(2);
    expect(baked[0][5]).toBe(10);
    expect(baked[1][5]).toBe(110);
  });

  it('caches by content key and hands out fresh copies on a hit', async () => {
    const stretch = makeFakeStretch();
    const channels = [ramp(40)];
    const first = await bakeWarpedClip(channels, 10, makeWarpClip(), 120, {
      cacheKey: 'asset-x',
      stretch,
    });
    // A deep-equal but distinct clip object still hits (content keying), but
    // the buffers are copies: callers bake fades into them in place, so a
    // shared instance would compound the fade ramps across passes.
    const second = await bakeWarpedClip(channels, 10, makeWarpClip(), 120, {
      cacheKey: 'asset-x',
      stretch,
    });
    expect(second).toEqual(first);
    expect(second[0]).not.toBe(first[0]);
    second[0].fill(0);
    const third = await bakeWarpedClip(channels, 10, makeWarpClip(), 120, {
      cacheKey: 'asset-x',
      stretch,
    });
    expect(third).toEqual(first);
    expect(stretch).toHaveBeenCalledTimes(1);

    // Any key ingredient change misses: tempo here.
    const otherTempo = await bakeWarpedClip(channels, 10, makeWarpClip(), 60, {
      cacheKey: 'asset-x',
      stretch,
    });
    expect(otherTempo).not.toBe(first);

    // clearWarpBakeCache invalidates the entry.
    clearWarpBakeCache();
    const rebaked = await bakeWarpedClip(channels, 10, makeWarpClip(), 120, {
      cacheKey: 'asset-x',
      stretch,
    });
    expect(rebaked).not.toBe(first);
    expect(rebaked).toEqual(first);
  });

  it('does not cache without a cacheKey', async () => {
    const stretch = makeFakeStretch();
    const channels = [ramp(40)];
    const first = await bakeWarpedClip(channels, 10, makeWarpClip(), 120, { stretch });
    const second = await bakeWarpedClip(channels, 10, makeWarpClip(), 120, { stretch });
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(stretch).toHaveBeenCalledTimes(2);
  });
});
