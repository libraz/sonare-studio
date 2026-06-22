import { describe, expect, it } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { type AudioStemSeparator, separateAudioClipStems } from '@/project/audio-stems';

/** A minimal audio-clip window with neutral defaults. */
function clipWindow(
  overrides: Partial<{ assetId?: string; lengthPpq: number; sourceOffsetPpq: number }> = {},
) {
  return { assetId: 'asset-1', lengthPpq: 4, sourceOffsetPpq: 0, ...overrides };
}

/** A loaded asset with `channels` planar buffers of `frames` samples each. */
function asset(channelValues: number[], frames: number, sampleRate = 48000): LoadedAudioAsset {
  return {
    meta: {
      id: 'asset-1',
      name: 'a',
      sampleRate,
      numChannels: channelValues.length,
      numFrames: frames,
    },
    channels: channelValues.map((value) => new Float32Array(frames).fill(value)),
  } as LoadedAudioAsset;
}

// 96000 frames = 2.0 s at 48 kHz, the window for lengthPpq 4 at 120 BPM.
const WINDOW_FRAMES = 96000;

/**
 * Stem separator stub: each band is the input scaled by a fixed factor, so the
 * test can assert which band carries which channel. Captures the buffers seen.
 */
function separator(): {
  fn: AudioStemSeparator;
  seen: { length: number; sampleRate?: number }[];
} {
  const seen: { length: number; sampleRate?: number }[] = [];
  const fn: AudioStemSeparator = (samples, sampleRate) => {
    seen.push({ length: samples.length, sampleRate });
    return {
      harmonic: samples.map((v) => v * 2) as Float32Array,
      percussive: samples.map((v) => v * 3) as Float32Array,
      residual: samples.map((v) => v * 4) as Float32Array,
      sampleRate: sampleRate ?? 0,
    };
  };
  return { fn, seen };
}

describe('separateAudioClipStems', () => {
  it('separates each channel and assembles three planar stems in band order', async () => {
    const { fn, seen } = separator();
    const stems = await separateAudioClipStems(clipWindow(), 120, {
      loadAudioAsset: async () => asset([0.5, 0.25], WINDOW_FRAMES),
      separateStems: fn,
    });
    expect(stems.map((stem) => stem.kind)).toEqual(['harmonic', 'percussive', 'residual']);
    // Two source channels => the separator runs twice (once per channel).
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ length: WINDOW_FRAMES, sampleRate: 48000 });
    for (const stem of stems) {
      expect(stem.channels).toHaveLength(2);
      expect(stem.sampleRate).toBe(48000);
      expect(stem.channels[0]).toHaveLength(WINDOW_FRAMES);
    }
    // Bands scale by 2 / 3 / 4; channel 0 is filled with 0.5, channel 1 with 0.25.
    expect(stems[0].channels[0][0]).toBeCloseTo(1.0);
    expect(stems[1].channels[0][0]).toBeCloseTo(1.5);
    expect(stems[2].channels[1][0]).toBeCloseTo(1.0);
  });

  it('slices only the played window before separating', async () => {
    const { fn, seen } = separator();
    // lengthPpq 2 at 120 BPM = 1.0 s = 48000 frames out of a 96000-frame asset.
    await separateAudioClipStems(clipWindow({ lengthPpq: 2 }), 120, {
      loadAudioAsset: async () => asset([0.5], WINDOW_FRAMES),
      separateStems: fn,
    });
    expect(seen).toEqual([{ length: 48000, sampleRate: 48000 }]);
  });

  it('returns [] without an asset, at a non-positive tempo, or on an empty window', async () => {
    const { fn } = separator();
    await expect(
      separateAudioClipStems(clipWindow({ assetId: undefined }), 120, {
        loadAudioAsset: async () => asset([0.5], WINDOW_FRAMES),
        separateStems: fn,
      }),
    ).resolves.toEqual([]);
    await expect(
      separateAudioClipStems(clipWindow(), 0, {
        loadAudioAsset: async () => asset([0.5], WINDOW_FRAMES),
        separateStems: fn,
      }),
    ).resolves.toEqual([]);
    await expect(
      separateAudioClipStems(clipWindow(), 120, {
        loadAudioAsset: async () => asset([0.5], 0),
        separateStems: fn,
      }),
    ).resolves.toEqual([]);
  });
});
