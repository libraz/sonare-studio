import { describe, expect, it, vi } from 'vitest';
import { warpedWaveformColumns } from '@/ui/arrangement/audio-clip-content';

const warpCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/project/warp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/project/warp')>();
  return {
    ...actual,
    warpSourceSecondsAt: (...args: Parameters<typeof actual.warpSourceSecondsAt>) => {
      warpCalls.count++;
      return actual.warpSourceSecondsAt(...args);
    },
  };
});

describe('warpedWaveformColumns', () => {
  it('maps each column boundary through the warp once', () => {
    const peaks = {
      min: Float32Array.from([-1, -0.75, -0.5, -0.25]),
      max: Float32Array.from([1, 0.75, 0.5, 0.25]),
    };
    const columns = warpedWaveformColumns(
      peaks,
      {
        lengthPpq: 4,
        sourceOffsetPpq: 0,
        warp: { enabled: true, sourceBpm: 60, anchors: [{ ppq: 2, sourceSeconds: 1 }] },
      },
      0,
      4,
      4,
      4,
      1,
    );
    expect(columns).toHaveLength(4);
    expect(warpCalls.count).toBe(5);
  });
});
