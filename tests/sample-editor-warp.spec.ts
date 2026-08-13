import { describe, expect, it } from 'vitest';
import type { EditorClip } from '@/project/types';
import {
  autoWarpFromBeatTimes,
  defaultWarpAnchor,
  findWarpClip,
  isWarpableClip,
  mergedWarp,
  segmentStretchRatios,
  type WarpControlsClip,
} from '@/ui/sample-editor/warp-controls';

function audioClip(overrides: Partial<EditorClip> = {}): WarpControlsClip {
  return {
    id: 1,
    kind: 'audio',
    assetId: 'asset-a',
    lengthPpq: 8,
    sourceOffsetPpq: 0,
    ...overrides,
  };
}

describe('isWarpableClip', () => {
  it('accepts audio clips without takes', () => {
    expect(isWarpableClip(audioClip())).toBe(true);
    expect(isWarpableClip(audioClip({ takes: [] }))).toBe(true);
  });

  it('rejects MIDI clips and clips with takes', () => {
    expect(isWarpableClip({ kind: 'midi' })).toBe(false);
    expect(isWarpableClip({})).toBe(false); // absent kind defaults to midi
    expect(isWarpableClip(audioClip({ takes: [{ assetId: 'x', name: 'Take 1' }] }))).toBe(false);
  });
});

describe('findWarpClip', () => {
  const clips: WarpControlsClip[] = [
    audioClip({ id: 1, assetId: 'asset-a' }),
    audioClip({ id: 2, assetId: 'asset-a' }),
    audioClip({ id: 3, assetId: 'asset-b' }),
    audioClip({ id: 4, assetId: 'asset-c', takes: [{ assetId: 'asset-c', name: 'Take 1' }] }),
  ];

  it('prefers the active clip when it references the asset', () => {
    expect(findWarpClip(clips, 2, 'asset-a')?.id).toBe(2);
  });

  it('falls back to the first warpable clip referencing the asset', () => {
    expect(findWarpClip(clips, 3, 'asset-a')?.id).toBe(1);
    expect(findWarpClip(clips, -1, 'asset-b')?.id).toBe(3);
  });

  it('never picks clips with takes', () => {
    expect(findWarpClip(clips, 4, 'asset-c')).toBeNull();
  });

  it('returns null when no clip references the asset', () => {
    expect(findWarpClip(clips, 1, 'asset-missing')).toBeNull();
  });
});

describe('mergedWarp', () => {
  it('starts a warp-less clip disabled at the fallback tempo', () => {
    expect(mergedWarp(undefined, { enabled: true }, 120)).toEqual({
      enabled: true,
      sourceBpm: 120,
      anchors: [],
    });
  });

  it('keeps unchanged fields of the current state', () => {
    const current = { enabled: true, sourceBpm: 95, anchors: [{ ppq: 2, sourceSeconds: 1.2 }] };
    expect(mergedWarp(current, { sourceBpm: 100 }, 120)).toEqual({
      enabled: true,
      sourceBpm: 100,
      anchors: [{ ppq: 2, sourceSeconds: 1.2 }],
    });
    expect(mergedWarp(current, { enabled: false }, 120)).toEqual({ ...current, enabled: false });
  });

  it('preserves explicit trimmed source bounds across every partial edit', () => {
    const current = {
      enabled: true,
      sourceBpm: 90,
      sourceStartSeconds: 3,
      sourceEndSeconds: 9,
      anchors: [
        { ppq: 2, sourceSeconds: 1 },
        { ppq: 6, sourceSeconds: 4 },
      ],
    };

    expect(mergedWarp(current, { enabled: false }, 120)).toEqual({
      ...current,
      enabled: false,
    });
    expect(mergedWarp(current, { sourceBpm: 100 }, 120)).toEqual({
      ...current,
      sourceBpm: 100,
    });
    expect(
      mergedWarp(
        current,
        {
          anchors: [
            { ppq: 2, sourceSeconds: 2 },
            { ppq: 6, sourceSeconds: 4 },
          ],
        },
        120,
      ),
    ).toEqual({
      ...current,
      anchors: [
        { ppq: 2, sourceSeconds: 2 },
        { ppq: 6, sourceSeconds: 4 },
      ],
    });
  });
});

describe('defaultWarpAnchor', () => {
  it('places the first anchor at the clip midpoint with proportional source time', () => {
    // 4 beats at 100 BPM source = 2.4 s; midpoint = beat 2 at 1.2 s.
    expect(defaultWarpAnchor([], 4, 100)).toEqual({ ppq: 2, sourceSeconds: 1.2 });
  });

  it('splits the widest gap, interpolating source time inside it', () => {
    const anchor = defaultWarpAnchor([{ ppq: 1, sourceSeconds: 0.5 }], 4, 100);
    // Gaps: [0,1] and [1,4]; the widest spans beats 1..4 (0.5 s .. 2.4 s).
    expect(anchor).toEqual({ ppq: 2.5, sourceSeconds: (0.5 + 2.4) / 2 });
  });

  it('skips gaps whose source time does not advance', () => {
    // The trailing gap [1,4] maps to no source time, so the lead gap wins.
    const anchor = defaultWarpAnchor([{ ppq: 1, sourceSeconds: 2.4 }], 4, 100);
    expect(anchor).toEqual({ ppq: 0.5, sourceSeconds: 1.2 });
  });

  it('returns null for degenerate inputs', () => {
    expect(defaultWarpAnchor([], 0, 100)).toBeNull();
    expect(defaultWarpAnchor([], 4, 0)).toBeNull();
  });
});

describe('autoWarpFromBeatTimes', () => {
  it('turns detected beats and downbeats into a source BPM and warp anchors', () => {
    const warp = autoWarpFromBeatTimes([0, 0.5, 1.1, 1.7, 2.2], [1.1], 8);

    expect(warp?.sourceBpm).toBeCloseTo(109.0909, 4);
    expect(warp?.anchors).toEqual([
      { ppq: 1, sourceSeconds: 0.5 },
      { ppq: 2, sourceSeconds: 1.1 },
      { ppq: 3, sourceSeconds: 1.7 },
      { ppq: 4, sourceSeconds: 2.2 },
    ]);
  });

  it('returns null when there are not enough valid beats', () => {
    expect(autoWarpFromBeatTimes([0], [], 8)).toBeNull();
    expect(autoWarpFromBeatTimes([0, 0.5], [], 0)).toBeNull();
  });
});

describe('segmentStretchRatios', () => {
  it('reports the source-over-played ratio per segment', () => {
    const clip = audioClip({
      lengthPpq: 4,
      warp: { enabled: true, sourceBpm: 100, anchors: [{ ppq: 2, sourceSeconds: 1.5 }] },
    });
    // Source: 4 beats at 100 BPM = 2.4 s total; played: 4 beats at 120 BPM = 2 s.
    const ratios = segmentStretchRatios(clip, 120);
    expect(ratios).toHaveLength(2);
    expect(ratios[0]).toBeCloseTo(1.5 / 1, 6);
    expect(ratios[1]).toBeCloseTo(0.9 / 1, 6);
  });

  it('uses the clip timeline position and tempo map for played segment durations', () => {
    const clip = audioClip({
      startPpq: 4,
      lengthPpq: 4,
      warp: { enabled: true, sourceBpm: 100, anchors: [{ ppq: 2, sourceSeconds: 1.5 }] },
    });

    const ratios = segmentStretchRatios(clip, 120, [
      { startPpq: 0, bpm: 120 },
      { startPpq: 4, bpm: 60 },
    ]);

    expect(ratios).toHaveLength(2);
    expect(ratios[0]).toBeCloseTo(1.5 / 2, 6);
    expect(ratios[1]).toBeCloseTo(0.9 / 2, 6);
  });

  it('is empty when warp is disabled or the tempo is invalid', () => {
    expect(segmentStretchRatios(audioClip(), 120)).toEqual([]);
    expect(
      segmentStretchRatios(audioClip({ warp: { enabled: false, sourceBpm: 100 } }), 120),
    ).toEqual([]);
    expect(segmentStretchRatios(audioClip({ warp: { enabled: true, sourceBpm: 100 } }), 0)).toEqual(
      [],
    );
  });
});
