import type { BeatObservations, EstimateMeterRequest } from '@libraz/libsonare';
import { describe, expect, it, vi } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { estimateAudioClipMeter } from '@/project/audio-tempo';
import { timeSignature } from './fakes/analysis';

const CLIP = { assetId: 'asset', startPpq: 0, lengthPpq: 1, sourceOffsetPpq: 0 };

async function loadAudioAsset(): Promise<LoadedAudioAsset> {
  const samples = new Float32Array(4000).fill(0.25);
  return {
    meta: {
      id: CLIP.assetId,
      name: 'Window',
      sampleRate: 8000,
      numChannels: 1,
      numFrames: samples.length,
    },
    channels: [samples],
  };
}

describe('estimateAudioClipMeter observation handling', () => {
  const unmeasured: BeatObservations = {
    accent: [],
    hasAttack: [],
    lowFrequencyEnergy: [],
    subdivisionAccent: [],
    chordChange: [],
  };

  it('returns no detection and skips scoring when no accents were measured', async () => {
    const analyze = vi.fn(async () => unmeasured);
    const estimateMeter = vi.fn(() => ({
      timeSignature: timeSignature(),
      grouping: [2, 2],
      searched: true,
    }));

    await expect(
      estimateAudioClipMeter(CLIP, 120, { loadAudioAsset, analyze, estimateMeter }),
    ).resolves.toEqual([]);
    expect(analyze).toHaveBeenCalledOnce();
    expect(estimateMeter).not.toHaveBeenCalled();
  });

  it('passes a measured zero accent and leaves unmeasured streams empty', async () => {
    const observations: BeatObservations = {
      ...unmeasured,
      accent: [0.8, 0, 0.4, 0.2],
      hasAttack: [true, false, true, true],
      subdivisionAccent: [0.35, 0, 0.28],
    };
    const expectedObservations = structuredClone(observations);
    const estimateMeter = vi.fn((_request: EstimateMeterRequest) => ({
      timeSignature: timeSignature({ numerator: 4, denominator: 4 }),
      grouping: [2, 2],
      searched: true,
    }));

    await expect(
      estimateAudioClipMeter(CLIP, 120, {
        loadAudioAsset,
        analyze: async () => observations,
        estimateMeter,
      }),
    ).resolves.toEqual([{ startPpq: 0, numerator: 4, denominator: 4, grouping: [2, 2] }]);
    expect(estimateMeter).toHaveBeenCalledOnce();
    expect(estimateMeter).toHaveBeenCalledWith({ observations: expectedObservations });
  });
});
