import { describe, expect, it, vi } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { analyzeAudioClipMelody, type DetectedMelodyPoint } from '@/project/audio-melody';
import { MAJOR_MODE_MASK } from '@/project/types';

/** A minimal audio-clip window with neutral defaults. */
function clipWindow(
  overrides: Partial<{
    assetId?: string;
    startPpq: number;
    lengthPpq: number;
    sourceOffsetPpq: number;
  }> = {},
) {
  return { assetId: 'asset-1', startPpq: 0, lengthPpq: 4, sourceOffsetPpq: 0, ...overrides };
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
  fn: (
    samples: Float32Array,
    sampleRate?: number,
    options?: { usePyin?: boolean },
  ) => { points: DetectedMelodyPoint[] };
  seen: { length: number; sampleRate?: number; options?: { usePyin?: boolean } }[];
} {
  const seen: { length: number; sampleRate?: number; options?: { usePyin?: boolean } }[] = [];
  return {
    fn: (samples, sampleRate, options) => {
      seen.push({ length: samples.length, sampleRate, options });
      return { points };
    },
    seen,
  };
}

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
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
      { pitch: 71, startPpq: 1, durationPpq: 0.5, velocity: 88 },
      { pitch: 69, startPpq: 2, durationPpq: 2, velocity: 111 },
    ]);
    // The analyzer saw the non-empty mono window at the asset rate.
    expect(seen).toHaveLength(1);
    expect(seen[0].sampleRate).toBe(48000);
    expect(seen[0].length).toBeGreaterThan(0);
    expect(seen[0].options).toEqual({ usePyin: true });
  });

  it('allows callers to opt out of pYIN melody analysis', async () => {
    const { fn, seen } = analyzer([{ time: 0.0, frequency: 440, confidence: 1 }]);

    await analyzeAudioClipMelody(
      clipWindow(),
      120,
      {
        loadAudioAsset: async () => asset(WINDOW_FRAMES),
        analyzeMelody: fn,
      },
      { usePyin: false },
    );

    expect(seen[0].options).toEqual({ usePyin: false });
  });

  it('maps frame seconds to clip PPQ through the project tempo map when it varies', async () => {
    // 60 BPM (1 s/PPQ) until PPQ 2, then 120 BPM (0.5 s/PPQ). The pitch change
    // at 2 s lands on PPQ 2, and the run to the unvoiced frame at 3 s reaches
    // PPQ 4 (two quarters in that second) — twice the duration a constant
    // 60 BPM would give that tail.
    const { fn } = analyzer([
      { time: 0.0, frequency: 440, confidence: 1 },
      { time: 2.0, frequency: 493.88, confidence: 1 },
      { time: 3.0, frequency: 0, confidence: 0 },
    ]);
    const notes = await analyzeAudioClipMelody(
      clipWindow({ startPpq: 0, lengthPpq: 8 }),
      60,
      { loadAudioAsset: async () => asset(48000 * 8), analyzeMelody: fn },
      {},
      [
        { startPpq: 0, bpm: 60 },
        { startPpq: 2, bpm: 120 },
      ],
    );
    expect(notes).toEqual([
      { pitch: 69, startPpq: 0, durationPpq: 2, velocity: 127 },
      { pitch: 71, startPpq: 2, durationPpq: 2, velocity: 127 },
    ]);
  });

  it('quantizes detected pitches to the detected melody scale when the engine exposes key helpers', async () => {
    const { fn } = analyzer([
      { time: 0.0, frequency: midiToHz(66), confidence: 1 },
      { time: 0.5, frequency: 0, confidence: 0 },
    ]);
    const detectKey = vi.fn(() => ({ name: 'C major' }));
    const scaleQuantizeMidi = vi.fn((_root: number, _modeMask: number, midi: number) =>
      midi === 66 ? 65 : midi,
    );

    const notes = await analyzeAudioClipMelody(clipWindow(), 120, {
      loadAudioAsset: async () => asset(WINDOW_FRAMES),
      analyzeMelody: fn,
      detectKey,
      scaleQuantizeMidi,
    });

    expect(notes).toEqual([{ pitch: 65, startPpq: 0, durationPpq: 1, velocity: 127 }]);
    expect(detectKey).toHaveBeenCalledWith(expect.any(Float32Array), 48000);
    expect(scaleQuantizeMidi).toHaveBeenCalledWith(0, MAJOR_MODE_MASK, 66);
  });

  it('derives relative note velocities from the audio envelope', async () => {
    const quietThenLoud = asset(WINDOW_FRAMES);
    quietThenLoud.channels[0].fill(0.1, 0, WINDOW_FRAMES / 2);
    quietThenLoud.channels[0].fill(0.9, WINDOW_FRAMES / 2);
    const { fn } = analyzer([
      { time: 0.0, frequency: 440, confidence: 0.6 },
      { time: 1.0, frequency: midiToHz(71), confidence: 0.6 },
      { time: 1.5, frequency: 0, confidence: 0 },
    ]);

    const notes = await analyzeAudioClipMelody(clipWindow(), 120, {
      loadAudioAsset: async () => quietThenLoud,
      analyzeMelody: fn,
    });

    expect(notes).toHaveLength(2);
    expect(notes[0].velocity).toBeLessThan(notes[1].velocity);
    expect(notes[0].velocity).toBeGreaterThanOrEqual(48);
    expect(notes[1].velocity).toBeGreaterThanOrEqual(100);
  });

  it('snaps extracted note starts and ends to the requested rhythm grid', async () => {
    const { fn } = analyzer([
      { time: 0.12, frequency: 440, confidence: 1 },
      { time: 0.38, frequency: 0, confidence: 0 },
    ]);

    const notes = await analyzeAudioClipMelody(
      clipWindow(),
      120,
      {
        loadAudioAsset: async () => asset(WINDOW_FRAMES),
        analyzeMelody: fn,
      },
      { rhythmQuantizePpq: 0.5 },
    );

    expect(notes).toEqual([{ pitch: 69, startPpq: 0, durationPpq: 1, velocity: 127 }]);
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
