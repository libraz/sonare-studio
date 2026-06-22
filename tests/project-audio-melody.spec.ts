import { describe, expect, it } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { analyzeAudioClipMelody, type DetectedMelodyPoint } from '@/project/audio-melody';

/** A minimal audio-clip window with neutral defaults. */
function clipWindow(
  overrides: Partial<{ assetId?: string; lengthPpq: number; sourceOffsetPpq: number }> = {},
) {
  return { assetId: 'asset-1', lengthPpq: 4, sourceOffsetPpq: 0, ...overrides };
}

/** A loaded mono asset with `frames` samples at `sampleRate`. */
function asset(frames: number, sampleRate = 48000): LoadedAudioAsset {
  return {
    meta: { id: 'asset-1', name: 'a', sampleRate, numChannels: 1, numFrames: frames },
    channels: [new Float32Array(frames).fill(0.5)],
  } as LoadedAudioAsset;
}

/** Melody analyzer stub returning fixed points and capturing the buffers seen. */
function analyzer(points: DetectedMelodyPoint[]): {
  fn: (samples: Float32Array, sampleRate?: number) => { points: DetectedMelodyPoint[] };
  seen: { length: number; sampleRate?: number }[];
} {
  const seen: { length: number; sampleRate?: number }[] = [];
  return {
    fn: (samples, sampleRate) => {
      seen.push({ length: samples.length, sampleRate });
      return { points };
    },
    seen,
  };
}

// 96000 frames = 2.0 s at 48 kHz, the window length for lengthPpq 4 at 120 BPM.
const WINDOW_FRAMES = 96000;

describe('analyzeAudioClipMelody', () => {
  it('merges same-pitch voiced frames, splitting on pitch change and unvoiced gaps', async () => {
    // At 120 BPM, 1 s -> 2 PPQ (quarter notes). 440 Hz = MIDI 69, 493.88 = 71.
    const { fn, seen } = analyzer([
      { time: 0.0, frequency: 440, confidence: 1 },
      { time: 0.25, frequency: 440, confidence: 1 },
      { time: 0.5, frequency: 493.88, confidence: 0.5 },
      { time: 0.75, frequency: 0, confidence: 0 },
      { time: 1.0, frequency: 440, confidence: 0.8 },
    ]);
    const notes = await analyzeAudioClipMelody(clipWindow(), 120, {
      loadAudioAsset: async () => asset(WINDOW_FRAMES),
      analyzeMelody: fn,
    });
    expect(notes).toEqual([
      { pitch: 69, startPpq: 0, durationPpq: 1, velocity: 127 },
      { pitch: 71, startPpq: 1, durationPpq: 0.5, velocity: 64 },
      { pitch: 69, startPpq: 2, durationPpq: 2, velocity: 102 },
    ]);
    // The analyzer saw the non-empty mono window at the asset rate.
    expect(seen).toHaveLength(1);
    expect(seen[0].sampleRate).toBe(48000);
    expect(seen[0].length).toBeGreaterThan(0);
  });

  it('drops notes shorter than the minimum length', async () => {
    const { fn } = analyzer([
      { time: 0.0, frequency: 440, confidence: 1 },
      { time: 0.02, frequency: 493.88, confidence: 1 },
      { time: 0.04, frequency: 0, confidence: 0 },
    ]);
    const notes = await analyzeAudioClipMelody(clipWindow(), 120, {
      loadAudioAsset: async () => asset(WINDOW_FRAMES),
      analyzeMelody: fn,
    });
    expect(notes).toEqual([]);
  });

  it('honors an explicit minimum note length', async () => {
    const { fn } = analyzer([
      { time: 0.0, frequency: 440, confidence: 1 },
      { time: 0.2, frequency: 0, confidence: 0 },
    ]);
    const longEnough = await analyzeAudioClipMelody(clipWindow(), 120, {
      loadAudioAsset: async () => asset(WINDOW_FRAMES),
      analyzeMelody: fn,
    });
    expect(longEnough).toHaveLength(1);
    const tooStrict = await analyzeAudioClipMelody(
      clipWindow(),
      120,
      { loadAudioAsset: async () => asset(WINDOW_FRAMES), analyzeMelody: fn },
      { minNoteSeconds: 0.5 },
    );
    expect(tooStrict).toEqual([]);
  });

  it('drops frames whose rounded pitch lands outside the MIDI range', async () => {
    const { fn } = analyzer([
      { time: 0.0, frequency: 1, confidence: 1 }, // ~ -36 MIDI, out of range
      { time: 0.5, frequency: 440, confidence: 1 },
      { time: 1.0, frequency: 0, confidence: 0 },
    ]);
    const notes = await analyzeAudioClipMelody(clipWindow(), 120, {
      loadAudioAsset: async () => asset(WINDOW_FRAMES),
      analyzeMelody: fn,
    });
    expect(notes).toEqual([{ pitch: 69, startPpq: 1, durationPpq: 1, velocity: 127 }]);
  });

  it('returns [] without an asset, a non-positive tempo, or an empty window', async () => {
    const { fn } = analyzer([{ time: 0, frequency: 440, confidence: 1 }]);
    const deps = { loadAudioAsset: async () => asset(WINDOW_FRAMES), analyzeMelody: fn };
    expect(await analyzeAudioClipMelody(clipWindow({ assetId: undefined }), 120, deps)).toEqual([]);
    expect(await analyzeAudioClipMelody(clipWindow(), 0, deps)).toEqual([]);
    expect(
      await analyzeAudioClipMelody(clipWindow({ lengthPpq: 0 }), 120, {
        loadAudioAsset: async () => asset(0),
        analyzeMelody: fn,
      }),
    ).toEqual([]);
  });
});
