import { describe, expect, it } from 'vitest';
import { normalizeTempoMap } from '@/project/tempo-map';
import type { WarpAnchor } from '@/project/types';
import {
  projectWarpMapDesc,
  sanitizeWarpAnchors,
  type WarpableClipFields,
  warpedClipSource,
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

/** Index ramp (channel[i] = i) so source positions are observable. */
function ramp(frames: number): Float32Array {
  const channel = new Float32Array(frames);
  for (let i = 0; i < frames; i++) channel[i] = i;
  return channel;
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

  it('keeps an explicit trimmed source window when anchors bend the mapping', () => {
    const clip = makeWarpClip({
      lengthPpq: 8,
      sourceOffsetPpq: 2,
      warp: {
        enabled: true,
        sourceBpm: 120,
        sourceStartSeconds: 3,
        sourceEndSeconds: 9,
        anchors: [
          { ppq: 2, sourceSeconds: 1 },
          { ppq: 6, sourceSeconds: 4 },
        ],
      },
    });
    expect(warpSegments(clip)).toEqual([
      { ppq: 0, lengthPpq: 2, sourceStartSeconds: 3, sourceLengthSeconds: 1 },
      { ppq: 2, lengthPpq: 4, sourceStartSeconds: 4, sourceLengthSeconds: 3 },
      { ppq: 6, lengthPpq: 2, sourceStartSeconds: 7, sourceLengthSeconds: 2 },
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

describe('projectWarpMapDesc', () => {
  it('adds the trimmed source offset to clip-relative user anchors', () => {
    const clip = {
      id: 7,
      startPpq: 0,
      lengthPpq: 4,
      sourceOffsetPpq: 2,
      warp: {
        enabled: true,
        sourceBpm: 120,
        anchors: [{ ppq: 2, sourceSeconds: 0.5 }],
      },
    };
    const desc = projectWarpMapDesc(clip, normalizeTempoMap([{ startPpq: 0, bpm: 120 }]), 10);
    const segments = warpSegments(clip);

    expect(desc?.anchors).toEqual([
      { warpSample: 0, sourceSample: 10 },
      { warpSample: 10, sourceSample: 15 },
      { warpSample: 20, sourceSample: 30 },
    ]);
    expect(desc?.anchors.map((anchor) => anchor.sourceSample)).toEqual([
      Math.round(segments[0].sourceStartSeconds * 10),
      Math.round((segments[0].sourceStartSeconds + segments[0].sourceLengthSeconds) * 10),
      Math.round((segments[1].sourceStartSeconds + segments[1].sourceLengthSeconds) * 10),
    ]);
  });
});

describe('warpedClipSource', () => {
  it('returns null for disabled/invalid warp and for empty channels', () => {
    expect(warpedClipSource([ramp(40)], 10, makeWarpClip({ warp: undefined }), 120)).toBeNull();
    expect(
      warpedClipSource(
        [ramp(40)],
        10,
        makeWarpClip({ warp: { enabled: false, sourceBpm: 60 } }),
        120,
      ),
    ).toBeNull();
    expect(warpedClipSource([], 10, makeWarpClip(), 120)).toBeNull();
    expect(warpedClipSource([new Float32Array(0)], 10, makeWarpClip(), 120)).toBeNull();
  });

  it('maps the clip window onto its source slice at the target tempo', () => {
    // 4 PPQ at 60 source BPM = 40 source frames; at 120 BPM the window is 20 frames.
    const source = warpedClipSource([ramp(40)], 10, makeWarpClip(), 120);
    expect(source?.lengthFrames).toBe(20);
    expect(source?.anchors).toEqual([
      { warpSample: 0, sourceSample: 0 },
      { warpSample: 20, sourceSample: 40 },
    ]);
    expect(source?.channels[0]).toEqual(ramp(40));
  });

  it('follows tempo-map changes on the output axis', () => {
    const tempo = normalizeTempoMap([
      { startPpq: 0, bpm: 120 },
      { startPpq: 2, bpm: 60 },
    ]);
    // 2 PPQ at 120 BPM (10 frames) plus 2 PPQ at 60 BPM (20 frames).
    const source = warpedClipSource([ramp(40)], 10, makeWarpClip(), tempo);
    expect(source?.lengthFrames).toBe(30);
    expect(source?.anchors.at(-1)).toEqual({ warpSample: 30, sourceSample: 40 });
  });

  it('adds an anchor per user warp anchor', () => {
    const clip = makeWarpClip({
      warp: { enabled: true, sourceBpm: 60, anchors: [{ ppq: 2, sourceSeconds: 1 }] },
    });
    expect(warpedClipSource([ramp(40)], 10, clip, 120)?.anchors).toEqual([
      { warpSample: 0, sourceSample: 0 },
      { warpSample: 10, sourceSample: 10 },
      { warpSample: 20, sourceSample: 40 },
    ]);
  });

  it('slices the trimmed source window and anchors relative to it', () => {
    const clip = makeWarpClip({ sourceOffsetPpq: 1, lengthPpq: 2 });
    const source = warpedClipSource([ramp(40)], 10, clip, 120);
    expect(Array.from(source?.channels[0] ?? [])).toEqual(
      Array.from({ length: 20 }, (_, i) => 10 + i),
    );
    expect(source?.anchors).toEqual([
      { warpSample: 0, sourceSample: 0 },
      { warpSample: 10, sourceSample: 20 },
    ]);
  });

  it('clamps an over-long source span to the asset end', () => {
    const source = warpedClipSource([ramp(15)], 10, makeWarpClip(), 120);
    expect(source?.channels[0].length).toBe(15);
    expect(source?.anchors).toEqual([
      { warpSample: 0, sourceSample: 0 },
      { warpSample: 20, sourceSample: 15 },
    ]);
  });

  it('returns null when the source starts past the asset', () => {
    expect(
      warpedClipSource([ramp(15)], 10, makeWarpClip({ sourceOffsetPpq: 100 }), 120),
    ).toBeNull();
  });

  it('copies the slice so the asset buffer is never shared with the engine', () => {
    const asset = ramp(40);
    const source = warpedClipSource([asset], 10, makeWarpClip(), 120);
    expect(source?.channels[0].buffer).not.toBe(asset.buffer);
  });
});
