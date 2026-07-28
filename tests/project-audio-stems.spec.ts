import { describe, expect, it } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { type AudioStemSeparator, separateAudioClipStems } from '@/project/audio-stems';
import { normalizeTempoMap } from '@/project/tempo-map';

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
  seen: { length: number; sampleRate?: number; first?: number }[];
} {
  const seen: { length: number; sampleRate?: number; first?: number }[] = [];
  const fn: AudioStemSeparator = (samples, sampleRate) => {
    seen.push({ length: samples.length, sampleRate, first: samples[0] });
    return {
      harmonic: samples.map((v) => v * 2) as Float32Array,
      percussive: samples.map((v) => v * 3) as Float32Array,
      residual: samples.map((v) => v * 4) as Float32Array,
      sampleRate: sampleRate ?? 0,
    };
  };
  return { fn, seen };
}

function sumPreservingSeparator(capture: (samples: Float32Array) => void): AudioStemSeparator {
  return (samples, sampleRate) => {
    capture(samples.slice());
    return {
      harmonic: samples.map((value) => value * 0.5),
      percussive: samples.map((value) => value * 0.3),
      residual: samples.map((value) => value * 0.2),
      sampleRate: sampleRate ?? 0,
    };
  };
}

function sampleAsset(id: string, values: number[], sampleRate: number): LoadedAudioAsset {
  return {
    meta: {
      id,
      name: id,
      sampleRate,
      numChannels: 1,
      numFrames: values.length,
    },
    channels: [new Float32Array(values)],
  } as LoadedAudioAsset;
}

describe('separateAudioClipStems', () => {
  it('separates stereo as linked mid/side and assembles planar stems in band order', async () => {
    const { fn, seen } = separator();
    const stems = await separateAudioClipStems(clipWindow(), 120, {
      loadAudioAsset: async () => asset([0.5, 0.25], WINDOW_FRAMES),
      separateStems: fn,
    });
    expect(stems.map((stem) => stem.kind)).toEqual(['harmonic', 'percussive', 'residual']);
    // Two source channels => the separator runs twice, on mid then side.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ length: WINDOW_FRAMES, sampleRate: 48000, first: 0.375 });
    expect(seen[1]).toEqual({ length: WINDOW_FRAMES, sampleRate: 48000, first: 0.125 });
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

  it('preserves stereo difference information through mid/side reconstruction', async () => {
    const stems = await separateAudioClipStems(clipWindow({ lengthPpq: 2 }), 120, {
      loadAudioAsset: async () =>
        ({
          meta: {
            id: 'asset-1',
            name: 'stereo',
            sampleRate: 48000,
            numChannels: 2,
            numFrames: WINDOW_FRAMES,
          },
          channels: [
            new Float32Array(WINDOW_FRAMES).fill(1),
            new Float32Array(WINDOW_FRAMES).fill(-1),
          ],
        }) as LoadedAudioAsset,
      separateStems: (samples, sampleRate) => ({
        harmonic: samples.slice(),
        percussive: new Float32Array(samples.length),
        residual: new Float32Array(samples.length),
        sampleRate: sampleRate ?? 0,
      }),
    });

    expect(stems[0].channels[0][0]).toBe(1);
    expect(stems[0].channels[1][0]).toBe(-1);
  });

  it('reconstructs each stem band from its own linked mid/side pair', async () => {
    let callIndex = 0;
    const stems = await separateAudioClipStems(clipWindow({ lengthPpq: 2 }), 120, {
      loadAudioAsset: async () =>
        ({
          meta: {
            id: 'asset-1',
            name: 'stereo',
            sampleRate: 48000,
            numChannels: 2,
            numFrames: WINDOW_FRAMES,
          },
          channels: [
            new Float32Array(WINDOW_FRAMES).fill(1),
            new Float32Array(WINDOW_FRAMES).fill(-0.5),
          ],
        }) as LoadedAudioAsset,
      separateStems: (samples, sampleRate) => {
        callIndex += 1;
        const isMid = callIndex === 1;
        return {
          harmonic: isMid ? samples.slice() : new Float32Array(samples.length),
          percussive: isMid ? new Float32Array(samples.length) : samples.slice(),
          residual: new Float32Array(samples.length),
          sampleRate: sampleRate ?? 0,
        };
      },
    });

    // Source L/R = 1/-0.5 => Mid 0.25 and Side 0.75.
    // Harmonic receives only Mid, so it reconstructs centered mono.
    expect(stems[0].channels[0][0]).toBeCloseTo(0.25);
    expect(stems[0].channels[1][0]).toBeCloseTo(0.25);
    // Percussive receives only Side, so it preserves the anti-phase difference.
    expect(stems[1].channels[0][0]).toBeCloseTo(0.75);
    expect(stems[1].channels[1][0]).toBeCloseTo(-0.75);
    expect(stems[2].channels[0][0]).toBe(0);
    expect(stems[2].channels[1][0]).toBe(0);
  });

  it('slices only the played window before separating', async () => {
    const { fn, seen } = separator();
    // lengthPpq 2 at 120 BPM = 1.0 s = 48000 frames out of a 96000-frame asset.
    await separateAudioClipStems(clipWindow({ lengthPpq: 2 }), 120, {
      loadAudioAsset: async () => asset([0.5], WINDOW_FRAMES),
      separateStems: fn,
    });
    expect(seen).toEqual([{ length: 48000, sampleRate: 48000, first: 0.5 }]);
  });

  it('renders comp take selection before separation', async () => {
    let input = new Float32Array();
    const stems = await separateAudioClipStems(
      {
        assetId: 'take-a',
        lengthPpq: 2,
        sourceOffsetPpq: 0,
        takes: [
          { assetId: 'take-a', name: 'A' },
          { assetId: 'take-b', name: 'B' },
        ],
        compSegments: [
          { startPpq: 0, takeIndex: 0 },
          { startPpq: 1, takeIndex: 1, crossfadePpq: 0 },
        ],
      },
      60,
      {
        loadAudioAsset: async (id) =>
          id === 'take-a' ? sampleAsset(id, [1, 2, 3, 4], 2) : sampleAsset(id, [10, 11, 12, 13], 2),
        separateStems: sumPreservingSeparator((samples) => {
          input = samples;
        }),
      },
    );

    expect([...input]).toEqual([1, 2, 12, 13]);
    for (let frame = 0; frame < input.length; frame += 1) {
      expect(stems.reduce((sum, stem) => sum + stem.channels[0][frame], 0)).toBeCloseTo(
        input[frame],
        6,
      );
    }
  });

  it('renders loop, fades and tempo changes before separation', async () => {
    let input = new Float32Array();
    const tempoMap = normalizeTempoMap([
      { startPpq: 0, bpm: 60 },
      { startPpq: 1, bpm: 120 },
    ]);
    const stems = await separateAudioClipStems(
      {
        assetId: 'loop',
        startPpq: 0,
        lengthPpq: 2,
        sourceOffsetPpq: 0,
        loopEnabled: true,
        loopLengthPpq: 1,
        fadeInPpq: 0.25,
        fadeOutPpq: 0.5,
      },
      tempoMap,
      {
        loadAudioAsset: async (id) => sampleAsset(id, [1, 2, 3, 4, 5, 6, 7, 8], 4),
        separateStems: sumPreservingSeparator((samples) => {
          input = samples;
        }),
      },
    );

    expect([...input]).toEqual([0, 2, 3, 4, 1, 0]);
    for (let frame = 0; frame < input.length; frame += 1) {
      expect(stems.reduce((sum, stem) => sum + stem.channels[0][frame], 0)).toBeCloseTo(
        input[frame],
        6,
      );
    }
  });

  it('renders trimmed warp, fades and a tempo change before separation', async () => {
    let input = new Float32Array();
    const tempoMap = normalizeTempoMap([
      { startPpq: 0, bpm: 120 },
      { startPpq: 1, bpm: 60 },
    ]);
    const stems = await separateAudioClipStems(
      {
        assetId: 'warp',
        startPpq: 0,
        lengthPpq: 2,
        sourceOffsetPpq: 1,
        fadeInPpq: 0.5,
        fadeOutPpq: 0.5,
        warp: { enabled: true, sourceBpm: 60 },
      },
      tempoMap,
      {
        loadAudioAsset: async (id) =>
          sampleAsset(
            id,
            Array.from({ length: 16 }, (_, index) => index),
            4,
          ),
        stretch: (samples, _sampleRate, rate) => {
          const output = new Float32Array(Math.round(samples.length / rate));
          for (let index = 0; index < output.length; index += 1) {
            output[index] = samples[Math.min(samples.length - 1, Math.round(index * rate))];
          }
          return output;
        },
        separateStems: sumPreservingSeparator((samples) => {
          input = samples;
        }),
      },
    );

    expect([...input]).toEqual([0, 5, 7, 8, 4.5, 0]);
    for (let frame = 0; frame < input.length; frame += 1) {
      expect(stems.reduce((sum, stem) => sum + stem.channels[0][frame], 0)).toBeCloseTo(
        input[frame],
        6,
      );
    }
  });

  it('repairs separator output length drift with phaseVocoder when available', async () => {
    const phaseCalls: Array<{ length: number; sampleRate: number; rate: number }> = [];
    const stems = await separateAudioClipStems(clipWindow({ lengthPpq: 2 }), 120, {
      loadAudioAsset: async () => asset([0.5], WINDOW_FRAMES),
      separateStems: (samples, sampleRate) => ({
        harmonic: new Float32Array(samples.length + 100).fill(1),
        percussive: new Float32Array(samples.length - 100).fill(2),
        residual: new Float32Array(samples.length).fill(3),
        sampleRate: sampleRate ?? 0,
      }),
      enhancers: {
        phaseVocoder: (samples, sampleRate, rate) => {
          phaseCalls.push({ length: samples.length, sampleRate, rate });
          return new Float32Array(48000).fill(samples[0] ?? 0);
        },
      },
    });

    expect(phaseCalls).toEqual([
      { length: 48100, sampleRate: 48000, rate: 48100 / 48000 },
      { length: 47900, sampleRate: 48000, rate: 47900 / 48000 },
    ]);
    expect(stems.map((stem) => stem.channels[0].length)).toEqual([48000, 48000, 48000]);
    expect(stems[0].channels[0][0]).toBe(1);
    expect(stems[1].channels[0][0]).toBe(2);
    expect(stems[2].channels[0][0]).toBe(3);
  });

  it('crops or pads drifted separator outputs when phaseVocoder is unavailable', async () => {
    const stems = await separateAudioClipStems(clipWindow({ lengthPpq: 2 }), 120, {
      loadAudioAsset: async () => asset([0.5], WINDOW_FRAMES),
      separateStems: (samples, sampleRate) => ({
        harmonic: new Float32Array(samples.length + 1).fill(1),
        percussive: new Float32Array(samples.length - 1).fill(2),
        residual: new Float32Array(samples.length).fill(3),
        sampleRate: sampleRate ?? 0,
      }),
    });

    expect(stems.map((stem) => stem.channels[0].length)).toEqual([48000, 48000, 48000]);
    expect(stems[0].channels[0][47999]).toBe(1);
    expect(stems[1].channels[0][47998]).toBe(2);
    expect(stems[1].channels[0][47999]).toBe(0);
  });

  it('refines waveform stems through nnFilter when it returns equal-length matrix data', async () => {
    const calls: Array<{ length: number; nFeatures: number; nFrames: number }> = [];
    const stems = await separateAudioClipStems(clipWindow({ lengthPpq: 2 }), 120, {
      loadAudioAsset: async () => asset([0.5], WINDOW_FRAMES),
      separateStems: (samples, sampleRate) => ({
        harmonic: new Float32Array(samples.length).fill(1),
        percussive: new Float32Array(samples.length).fill(2),
        residual: new Float32Array(samples.length).fill(3),
        sampleRate: sampleRate ?? 0,
      }),
      enhancers: {
        nnFilter: (samples, nFeatures, nFrames) => {
          calls.push({ length: samples.length, nFeatures, nFrames });
          return { data: samples.map((value) => value + 0.25) as Float32Array };
        },
      },
    });

    expect(calls).toEqual([
      { length: 48000, nFeatures: 1, nFrames: 48000 },
      { length: 48000, nFeatures: 1, nFrames: 48000 },
      { length: 48000, nFeatures: 1, nFrames: 48000 },
    ]);
    expect(stems[0].channels[0][0]).toBe(1.25);
    expect(stems[1].channels[0][0]).toBe(2.25);
    expect(stems[2].channels[0][0]).toBe(3.25);
  });

  it('keeps separator waveform stems when nnFilter cannot produce a same-length result', async () => {
    const stems = await separateAudioClipStems(clipWindow({ lengthPpq: 2 }), 120, {
      loadAudioAsset: async () => asset([0.5], WINDOW_FRAMES),
      separateStems: (samples, sampleRate) => ({
        harmonic: new Float32Array(samples.length).fill(1),
        percussive: new Float32Array(samples.length).fill(2),
        residual: new Float32Array(samples.length).fill(3),
        sampleRate: sampleRate ?? 0,
      }),
      enhancers: {
        nnFilter: (samples) => {
          if (samples[0] === 1) return { data: new Float32Array(samples.length - 1).fill(9) };
          if (samples[0] === 2) throw new Error('nnFilter failed');
          return null;
        },
      },
    });

    expect(stems[0].channels[0][0]).toBe(1);
    expect(stems[1].channels[0][0]).toBe(2);
    expect(stems[2].channels[0][0]).toBe(3);
  });

  it('uses decompose activations as a conservative HPSS bleed gate', async () => {
    const decomposeCalls: Array<{
      length: number;
      nFeatures: number;
      nFrames: number;
      nComponents: number;
      init?: string;
    }> = [];
    const stems = await separateAudioClipStems(clipWindow({ lengthPpq: 2 }), 120, {
      loadAudioAsset: async () => asset([1], WINDOW_FRAMES),
      separateStems: (samples, sampleRate) => ({
        harmonic: new Float32Array(samples.length).fill(1),
        percussive: new Float32Array(samples.length).fill(1),
        residual: new Float32Array(samples.length).fill(0.5),
        sampleRate: sampleRate ?? 0,
      }),
      enhancers: {
        decomposeWithInit: (samples, nFeatures, nFrames, nComponents, _nIter, _beta, init) => {
          decomposeCalls.push({
            length: samples.length,
            nFeatures,
            nFrames,
            nComponents,
            init,
          });
          const activations = new Float32Array(nFrames * 2);
          activations.fill(1, 0, nFrames);
          for (let index = 0; index < nFrames; index += 1) {
            activations[nFrames + index] = index % 2 === 0 ? 0 : 10;
          }
          return { h: activations };
        },
      },
    });

    expect(decomposeCalls).toEqual([
      {
        length: 48000,
        nFeatures: 1,
        nFrames: 48000,
        nComponents: 2,
        init: 'nndsvd',
      },
    ]);
    expect(stems[0].channels[0][0]).toBeCloseTo(1.35);
    expect(stems[0].channels[0][1]).toBeCloseTo(0.6818, 3);
    expect(stems[1].channels[0][0]).toBeCloseTo(0.65);
    expect(stems[1].channels[0][1]).toBeCloseTo(1.3182, 3);
    expect(stems[0].channels[0][0] + stems[1].channels[0][0]).toBeCloseTo(2);
    expect(stems[0].channels[0][1] + stems[1].channels[0][1]).toBeCloseTo(2);
    expect(stems[2].channels[0][0]).toBe(0.5);
  });

  it('keeps HPSS stems when decompose activations cannot be used', async () => {
    const stems = await separateAudioClipStems(clipWindow({ lengthPpq: 2 }), 120, {
      loadAudioAsset: async () => asset([1], WINDOW_FRAMES),
      separateStems: (samples, sampleRate) => ({
        harmonic: new Float32Array(samples.length).fill(1),
        percussive: new Float32Array(samples.length).fill(2),
        residual: new Float32Array(samples.length).fill(3),
        sampleRate: sampleRate ?? 0,
      }),
      enhancers: {
        decompose: () => ({ h: new Float32Array(8) }),
      },
    });

    expect(stems[0].channels[0][0]).toBe(1);
    expect(stems[1].channels[0][0]).toBe(2);
    expect(stems[2].channels[0][0]).toBe(3);
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
