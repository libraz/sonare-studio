import { describe, expect, it } from 'vitest';
import { normalizeTempoMap } from '@/project/tempo-map';
import { projectWarpMapDesc } from '@/project/warp';

const tempo = normalizeTempoMap([{ startPpq: 0, bpm: 120 }]);

function strictlyIncreasing(anchors: ReadonlyArray<{ warpSample: number; sourceSample: number }>) {
  return anchors.every(
    (anchor, i) =>
      i === 0 ||
      (anchor.warpSample > anchors[i - 1].warpSample &&
        anchor.sourceSample > anchors[i - 1].sourceSample),
  );
}

describe('projectWarpMapDesc anchor order', () => {
  it('drops a user anchor placed past the end of the source window', () => {
    const desc = projectWarpMapDesc(
      {
        id: 3,
        startPpq: 0,
        lengthPpq: 4,
        sourceOffsetPpq: 0,
        warp: { enabled: true, sourceBpm: 120, anchors: [{ ppq: 2, sourceSeconds: 30 }] },
      },
      tempo,
      100,
    );

    expect(desc).not.toBeNull();
    expect(strictlyIncreasing(desc!.anchors)).toBe(true);
  });

  it('drops an anchor that rounds onto its neighbour', () => {
    const desc = projectWarpMapDesc(
      {
        id: 4,
        startPpq: 0,
        lengthPpq: 4,
        sourceOffsetPpq: 0,
        warp: { enabled: true, sourceBpm: 120, anchors: [{ ppq: 0.001, sourceSeconds: 0.001 }] },
      },
      tempo,
      10,
    );

    expect(strictlyIncreasing(desc!.anchors)).toBe(true);
  });
});
