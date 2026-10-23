import { describe, expect, it, vi } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import {
  beatsToTimeSignatures,
  beatTimesToTempoSegments,
  detectAudioClipBeatGrid,
  detectAudioClipTempoMap,
  detectAudioClipTimeSignatures,
  estimateAudioClipMeter,
  ODD_METER_CANDIDATES,
} from '@/project/audio-tempo';

/** A minimal audio-clip window with neutral defaults. */
function clipWindow(
  overrides: Partial<{
    assetId?: string;
    startPpq: number;
    lengthPpq: number;
    sourceOffsetPpq: number;
  }> = {},
) {
  return { assetId: 'asset-1', startPpq: 0, lengthPpq: 16, sourceOffsetPpq: 0, ...overrides };
}

/** A loaded asset with `frames` mono samples at `sampleRate`. */
function asset(frames: number, sampleRate = 48000): LoadedAudioAsset {
  return {
    meta: { id: 'asset-1', name: 'a', sampleRate, numChannels: 1, numFrames: frames },
    channels: [new Float32Array(frames).fill(0.5)],
  } as LoadedAudioAsset;
}

describe('detectAudioClipBeatGrid', () => {
  const clip = { assetId: 'asset-1', startPpq: 0, lengthPpq: 16, sourceOffsetPpq: 0 };

  it('fits the grid of the audible window the beat tracker hears', async () => {
    const seen: Array<{ length: number; sampleRate: number }> = [];
    const beats = Array.from({ length: 16 }, (_, index) => 0.25 + index * 0.5);
    const grid = await detectAudioClipBeatGrid(clip, [{ startPpq: 0, bpm: 120 }], 4, {
      loadAudioAsset: async () => asset(48000 * 20),
      detectBeats: async (mono, sampleRate) => {
        seen.push({ length: mono.length, sampleRate });
        return { beats, downbeats: [beats[1], beats[5], beats[9]] };
      },
    });
    // 16 PPQ at 120 BPM is the 8 s audible window.
    expect(seen).toEqual([{ length: 8 * 48000, sampleRate: 48000 }]);
    expect(grid?.bpm).toBeCloseTo(120, 6);
    expect(grid?.downbeatSeconds).toBeCloseTo(0.75, 6);
  });

  it('returns null when nothing is audible or too few beats are tracked', async () => {
    const deps = {
      loadAudioAsset: async () => asset(48000 * 20),
      detectBeats: async () => ({ beats: [1], downbeats: [] }),
    };
    expect(await detectAudioClipBeatGrid(clip, [{ startPpq: 0, bpm: 120 }], 4, deps)).toBeNull();
    expect(
      await detectAudioClipBeatGrid(
        { ...clip, lengthPpq: 0 },
        [{ startPpq: 0, bpm: 120 }],
        4,
        deps,
      ),
    ).toBeNull();
  });
});

describe('beatTimesToTempoSegments', () => {
  it('maps each beat interval to a constant segment on the quarter-note grid', () => {
    // 0.5 s spacing => 120 BPM; beats land on quarter PPQ 0, 1, 2.
    const segments = beatTimesToTempoSegments([1, 1.5, 2, 2.5]);
    expect(segments).toEqual([{ startPpq: 0, bpm: 120 }]);
  });

  it('emits a new segment only where the tempo changes, anchored at PPQ 0', () => {
    // 0.5 s, 0.5 s, then 0.25 s (240 BPM): change at the third interval.
    const segments = beatTimesToTempoSegments([0.2, 0.7, 1.2, 1.45]);
    expect(segments).toEqual([
      { startPpq: 0, bpm: 120 },
      { startPpq: 2, bpm: 240 },
    ]);
  });

  it('clamps BPM into the given bounds', () => {
    // 0.1 s spacing => 600 BPM, clamped to 400.
    const fast = beatTimesToTempoSegments([0, 0.1], { maxBpm: 400 });
    expect(fast).toEqual([{ startPpq: 0, bpm: 400 }]);
    // 6 s spacing => 10 BPM, clamped to 20.
    const slow = beatTimesToTempoSegments([0, 6], { minBpm: 20 });
    expect(slow).toEqual([{ startPpq: 0, bpm: 20 }]);
  });

  it('drops non-finite and non-ascending beats and needs at least two', () => {
    expect(beatTimesToTempoSegments([])).toEqual([]);
    expect(beatTimesToTempoSegments([1])).toEqual([]);
    // NaN and the out-of-order 0.4 are dropped, leaving 0.5/1.0/1.5 => 120 BPM.
    const segments = beatTimesToTempoSegments([0.5, Number.NaN, 0.4, 1, 1.5]);
    expect(segments).toEqual([{ startPpq: 0, bpm: 120 }]);
  });
});

describe('detectAudioClipTempoMap', () => {
  it('tracks beats over the sliced window and converts them to a tempo map', async () => {
    const seen: { length: number; sampleRate?: number }[] = [];
    const segments = await detectAudioClipTempoMap(clipWindow({ lengthPpq: 16 }), 120, {
      loadAudioAsset: async () => asset(48000 * 20),
      detectBeats: async (samples, sampleRate) => {
        seen.push({ length: samples.length, sampleRate });
        return { beats: [0, 0.5, 1, 1.5], downbeats: [] };
      },
    });
    expect(segments).toEqual([{ startPpq: 0, bpm: 120 }]);
    expect(seen).toEqual([{ length: 8 * 48000, sampleRate: 48000 }]);
  });

  it('analyses the frames playback schedules under a tempo map', async () => {
    const seen: number[] = [];
    // 120 BPM until PPQ 8, then 60 BPM: 8 PPQ at the change play for 8 s, not the 4 s of a flat 120.
    await detectAudioClipTempoMap(
      clipWindow({ startPpq: 8, lengthPpq: 8 }),
      120,
      {
        loadAudioAsset: async () => asset(48000 * 20),
        detectBeats: async (samples) => {
          seen.push(samples.length);
          return { beats: [0, 1], downbeats: [] };
        },
      },
      undefined,
      [
        { startPpq: 0, bpm: 120 },
        { startPpq: 8, bpm: 60 },
      ],
    );
    expect(seen).toEqual([8 * 48000]);
  });

  it('returns an empty map without an asset, at non-positive tempo, or on an empty window', async () => {
    const deps = {
      loadAudioAsset: async () => asset(48000),
      detectBeats: async () => ({ beats: [0, 0.5, 1], downbeats: [] }),
    };
    expect(await detectAudioClipTempoMap(clipWindow({ assetId: undefined }), 120, deps)).toEqual(
      [],
    );
    expect(await detectAudioClipTempoMap(clipWindow(), 0, deps)).toEqual([]);
    expect(
      await detectAudioClipTempoMap(clipWindow(), 120, {
        ...deps,
        loadAudioAsset: async () => asset(0),
      }),
    ).toEqual([]);
  });

  it('returns an empty map when fewer than two beats are tracked', async () => {
    const segments = await detectAudioClipTempoMap(clipWindow(), 120, {
      loadAudioAsset: async () => asset(48000),
      detectBeats: async () => ({ beats: [0.5], downbeats: [] }),
    });
    expect(segments).toEqual([]);
  });
});

describe('beatsToTimeSignatures', () => {
  // Eight quarter-note beats at 0.5 s spacing; downbeats every fourth => 4/4.
  const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];

  it('counts beats between downbeats as the bar numerator, anchored at PPQ 0', () => {
    const segments = beatsToTimeSignatures(beats, [0, 2]);
    expect(segments).toEqual([{ startPpq: 0, numerator: 4, denominator: 4 }]);
  });

  it('emits a new segment only where the meter changes', () => {
    // Downbeats at beats 0, 4, 7 => a 4/4 bar then a 3/4 bar.
    const segments = beatsToTimeSignatures(beats, [0, 2, 3.5]);
    expect(segments).toEqual([
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 4, numerator: 3, denominator: 4 },
    ]);
  });

  it('anchors the first downbeat at PPQ 0 even with a pickup before it', () => {
    // First downbeat at beat 1 (a one-beat pickup); bars are 4 beats each.
    const segments = beatsToTimeSignatures(beats, [0.5, 2.5]);
    expect(segments).toEqual([{ startPpq: 0, numerator: 4, denominator: 4 }]);
  });

  it('clamps the numerator and needs at least two beats and two downbeats', () => {
    expect(beatsToTimeSignatures(beats, [0])).toEqual([]);
    expect(beatsToTimeSignatures([0], [0, 1])).toEqual([]);
    const clamped = beatsToTimeSignatures(beats, [0, 3.5], { maxNumerator: 4 });
    expect(clamped).toEqual([{ startPpq: 0, numerator: 4, denominator: 4 }]);
  });
});

describe('detectAudioClipTimeSignatures', () => {
  it('tracks beats and downbeats over the window and derives the meter', async () => {
    const segments = await detectAudioClipTimeSignatures(clipWindow({ lengthPpq: 16 }), 120, {
      loadAudioAsset: async () => asset(48000 * 20),
      detectBeats: async () => ({ beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], downbeats: [0, 2] }),
    });
    expect(segments).toEqual([{ startPpq: 0, numerator: 4, denominator: 4 }]);
  });

  it('returns an empty map without an asset, at non-positive tempo, or on an empty window', async () => {
    const deps = {
      loadAudioAsset: async () => asset(48000),
      detectBeats: async () => ({ beats: [0, 0.5, 1, 1.5], downbeats: [0, 1.5] }),
    };
    expect(
      await detectAudioClipTimeSignatures(clipWindow({ assetId: undefined }), 120, deps),
    ).toEqual([]);
    expect(await detectAudioClipTimeSignatures(clipWindow(), 0, deps)).toEqual([]);
    expect(
      await detectAudioClipTimeSignatures(clipWindow(), 120, {
        ...deps,
        loadAudioAsset: async () => asset(0),
      }),
    ).toEqual([]);
  });
});

describe('estimateAudioClipMeter', () => {
  const beatTimes = Array.from({ length: 14 }, (_, index) => index * 0.5);
  const analysis = { beatTimes, beatStrengths: beatTimes.map(() => 1) };

  it('reads one meter with its grouping over the clip, from the requested candidates', async () => {
    const estimateMeter = vi.fn(() => ({
      timeSignature: { numerator: 7, denominator: 4 },
      grouping: [3, 2, 2],
      searched: true,
    }));
    const segments = await estimateAudioClipMeter(
      clipWindow(),
      120,
      {
        loadAudioAsset: async () => asset(48000 * 8),
        analyze: async () => analysis,
        estimateMeter,
      },
      ODD_METER_CANDIDATES,
    );
    expect(segments).toEqual([{ startPpq: 0, numerator: 7, denominator: 4, grouping: [3, 2, 2] }]);
    expect(estimateMeter).toHaveBeenCalledWith(
      expect.objectContaining({ candidateNumerators: [2, 3, 4, 5, 6, 7] }),
    );
  });

  it('reports nothing when the series was too short to search or the accents do not line up', async () => {
    const unsearched = () => ({
      timeSignature: { numerator: 4, denominator: 4 },
      grouping: [4],
      searched: false,
    });
    const deps = { loadAudioAsset: async () => asset(48000 * 8), estimateMeter: unsearched };
    expect(
      await estimateAudioClipMeter(clipWindow(), 120, { ...deps, analyze: async () => analysis }),
    ).toEqual([]);
    const misaligned = { beatTimes, beatStrengths: [1] };
    expect(
      await estimateAudioClipMeter(clipWindow(), 120, { ...deps, analyze: async () => misaligned }),
    ).toEqual([]);
  });
});

describe('clip analysis signal', () => {
  it('hands the abort signal to the off-thread detectors', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const detectBeats = async (_mono: Float32Array, _rate: number, signal?: AbortSignal) => {
      seen.push(signal);
      return { beats: [0, 0.5, 1], downbeats: [0, 1] };
    };
    const loadAudioAsset = async () => asset(48000 * 8);
    await detectAudioClipTempoMap(
      clipWindow(),
      120,
      { loadAudioAsset, detectBeats },
      undefined,
      [],
      controller.signal,
    );
    await detectAudioClipTimeSignatures(
      clipWindow(),
      120,
      { loadAudioAsset, detectBeats },
      undefined,
      [],
      controller.signal,
    );
    await estimateAudioClipMeter(
      clipWindow(),
      120,
      {
        loadAudioAsset,
        analyze: async (_mono, _rate, signal) => {
          seen.push(signal);
          return { beatTimes: [], beatStrengths: [] };
        },
        estimateMeter: () => ({
          timeSignature: { numerator: 4, denominator: 4 },
          grouping: [],
          searched: false,
        }),
      },
      undefined,
      [],
      controller.signal,
    );
    expect(seen).toEqual([controller.signal, controller.signal, controller.signal]);
  });
});
