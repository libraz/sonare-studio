import { describe, expect, it, vi } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import {
  commonTakeSilence,
  snapToCommonSilence,
  type TakeSilenceDeps,
} from '@/project/take-silence';
import { normalizeTempoMap } from '@/project/tempo-map';

const TEMPO_60 = normalizeTempoMap([{ startPpq: 0, bpm: 60 }]);

function asset(id: string, frames: number, sampleRate = 1000): LoadedAudioAsset {
  return {
    meta: { id, name: id, sampleRate, numChannels: 1, numFrames: frames },
    channels: [new Float32Array(frames).fill(0.1)],
  };
}

const clip = {
  startPpq: 4,
  lengthPpq: 2,
  sourceOffsetPpq: 0,
  takes: [
    { assetId: 'a', name: 'A' },
    { assetId: 'b', name: 'B' },
  ],
};

describe('commonTakeSilence', () => {
  it('turns the gaps between shared sounding intervals into clip-relative PPQ', async () => {
    // 60 BPM at 1 kHz: one quarter is 1000 frames.
    const splitSilenceCommon = vi.fn<TakeSilenceDeps['splitSilenceCommon']>(() =>
      Int32Array.from([0, 400, 900, 2000]),
    );
    const spans = await commonTakeSilence(clip, TEMPO_60, {
      loadAudioAsset: async (id) => asset(id, 2000),
      splitSilenceCommon,
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].startPpq).toBeCloseTo(0.4, 9);
    expect(spans[0].endPpq).toBeCloseTo(0.9, 9);
    expect(splitSilenceCommon.mock.calls[0][0]).toHaveLength(2);
  });

  it('drops gaps too short to cut in and scans nothing for one take or a loop', async () => {
    const deps = {
      loadAudioAsset: async (id: string) => asset(id, 2000),
      splitSilenceCommon: () => Int32Array.from([0, 1000, 1020, 2000]),
    };
    expect(await commonTakeSilence(clip, TEMPO_60, deps)).toEqual([]);
    expect(await commonTakeSilence({ ...clip, takes: [clip.takes[0]] }, TEMPO_60, deps)).toEqual(
      [],
    );
    expect(await commonTakeSilence({ ...clip, loopEnabled: true }, TEMPO_60, deps)).toEqual([]);
  });

  it('refuses takes recorded at different sample rates', async () => {
    const spans = await commonTakeSilence(clip, TEMPO_60, {
      loadAudioAsset: async (id) => asset(id, 2000, id === 'a' ? 1000 : 2000),
      splitSilenceCommon: () => Int32Array.from([0, 100]),
    });
    expect(spans).toEqual([]);
  });
});

describe('snapToCommonSilence', () => {
  it('moves an edge inside a shared silence to its centre and leaves others alone', () => {
    const spans = [{ startPpq: 1, endPpq: 2 }];
    expect(snapToCommonSilence(spans, 1.2)).toBe(1.5);
    expect(snapToCommonSilence(spans, 3)).toBe(3);
  });
});
