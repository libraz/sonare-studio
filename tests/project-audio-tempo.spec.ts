import { describe, expect, it } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import {
  type AudioTempoDetector,
  beatsToTimeSignatures,
  beatTimesToTempoSegments,
  detectAudioClipTempo,
  detectAudioClipTempoMap,
  detectAudioClipTimeSignatures,
} from '@/project/audio-tempo';

/** A minimal audio-clip window with neutral defaults. */
function clipWindow(
  overrides: Partial<{ assetId?: string; lengthPpq: number; sourceOffsetPpq: number }> = {},
) {
  return { assetId: 'asset-1', lengthPpq: 16, sourceOffsetPpq: 0, ...overrides };
}

/** A loaded asset with `frames` mono samples at `sampleRate`. */
function asset(frames: number, sampleRate = 48000): LoadedAudioAsset {
  return {
    meta: { id: 'asset-1', name: 'a', sampleRate, numChannels: 1, numFrames: frames },
    channels: [new Float32Array(frames).fill(0.5)],
  } as LoadedAudioAsset;
}

/** A detector returning a fixed BPM and capturing the buffer it saw. */
function detector(bpm: number): {
  fn: AudioTempoDetector;
  seen: { length: number; sampleRate?: number }[];
} {
  const seen: { length: number; sampleRate?: number }[] = [];
  return {
    fn: (samples, sampleRate) => {
      seen.push({ length: samples.length, sampleRate });
      return bpm;
    },
    seen,
  };
}

describe('detectAudioClipTempo', () => {
  it('returns the detected BPM, analyzing the sliced window at the asset rate', async () => {
    // 120 BPM, 16 PPQ window => 8 s => 8 * 48000 frames sliced.
    const det = detector(128);
    const bpm = await detectAudioClipTempo(clipWindow({ lengthPpq: 16 }), 120, {
      loadAudioAsset: async () => asset(48000 * 20),
      detectBpm: det.fn,
    });
    expect(bpm).toBe(128);
    expect(det.seen).toEqual([{ length: 8 * 48000, sampleRate: 48000 }]);
  });

  it('returns null without an asset, at non-positive tempo, or on an empty window', async () => {
    const det = detector(120);
    const deps = { loadAudioAsset: async () => asset(48000), detectBpm: det.fn };
    expect(await detectAudioClipTempo(clipWindow({ assetId: undefined }), 120, deps)).toBeNull();
    expect(await detectAudioClipTempo(clipWindow(), 0, deps)).toBeNull();
    expect(
      await detectAudioClipTempo(clipWindow(), 120, {
        ...deps,
        loadAudioAsset: async () => asset(0),
      }),
    ).toBeNull();
  });

  it('returns null when the detector yields a non-positive or non-finite BPM', async () => {
    const deps = { loadAudioAsset: async () => asset(48000) };
    expect(
      await detectAudioClipTempo(clipWindow(), 120, { ...deps, detectBpm: () => 0 }),
    ).toBeNull();
    expect(
      await detectAudioClipTempo(clipWindow(), 120, { ...deps, detectBpm: () => Number.NaN }),
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
      detectBeats: (samples, sampleRate) => {
        seen.push({ length: samples.length, sampleRate });
        return [0, 0.5, 1, 1.5];
      },
    });
    expect(segments).toEqual([{ startPpq: 0, bpm: 120 }]);
    expect(seen).toEqual([{ length: 8 * 48000, sampleRate: 48000 }]);
  });

  it('returns an empty map without an asset, at non-positive tempo, or on an empty window', async () => {
    const deps = { loadAudioAsset: async () => asset(48000), detectBeats: () => [0, 0.5, 1] };
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
      detectBeats: () => [0.5],
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
      detectBeats: () => [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
      detectDownbeats: () => [0, 2],
    });
    expect(segments).toEqual([{ startPpq: 0, numerator: 4, denominator: 4 }]);
  });

  it('returns an empty map without an asset, at non-positive tempo, or on an empty window', async () => {
    const deps = {
      loadAudioAsset: async () => asset(48000),
      detectBeats: () => [0, 0.5, 1, 1.5],
      detectDownbeats: () => [0, 1.5],
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
