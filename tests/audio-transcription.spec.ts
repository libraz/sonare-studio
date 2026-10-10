import { describe, expect, it, vi } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import {
  MAX_POLYPHONIC_SAMPLES,
  MAX_POLYPHONIC_SECONDS,
  transcribeAudioClip,
} from '@/project/audio-transcription';
import type { WarpedClipSource } from '@/project/warp';
import type { TranscribeResult } from '@/wasm/index.js';

function noteEvent(
  ppq: number,
  status: 0x8 | 0x9,
  pitch: number,
  velocity: number,
): {
  ppq: number;
  data0: number;
  data1: number;
} {
  return { ppq, data0: (0x20000000 | (status << 20) | (pitch << 8) | velocity) >>> 0, data1: 0 };
}

function asset(sampleRate: number, frames: number, channels = 2): LoadedAudioAsset {
  return {
    meta: {
      id: 'test-audio',
      name: 'test-audio',
      sampleRate,
      numChannels: channels,
      numFrames: frames,
    },
    channels: Array.from({ length: channels }, (_, index) =>
      Float32Array.from({ length: frames }, (_, frame) => ((index + 1) * (frame % 7)) / 10),
    ),
  };
}

function result(events: TranscribeResult['events']): TranscribeResult {
  return { events, noteCount: events.length / 2, tempoBpm: 60, tuning: 0 };
}

describe('transcribeAudioClip', () => {
  it('maps worker seconds through a variable tempo map and preserves velocity', async () => {
    const calls: Array<{ samples: Float32Array; sampleRate: number; polyphonic: boolean }> = [];
    const source = asset(1_000, 3_000, 1);
    source.channels[0] = Float32Array.from({ length: 3_000 }, (_, frame) => frame);
    const notes = await transcribeAudioClip(
      { assetId: 'test-audio', startPpq: 4, lengthPpq: 4, sourceOffsetPpq: 1 },
      60,
      {
        loadAudioAsset: async () => source,
        transcribe: async (samples, sampleRate, polyphonic) => {
          calls.push({ samples, sampleRate, polyphonic });
          return result([noteEvent(0.2, 0x9, 60, 37), noteEvent(1.2, 0x8, 60, 0)]);
        },
      },
      { polyphonic: false, rhythmQuantizePpq: 1 },
      [
        { startPpq: 0, bpm: 60 },
        { startPpq: 4, bpm: 120 },
      ],
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.samples.length).toBeGreaterThan(0);
    expect(calls[0]?.sampleRate).toBe(1_000);
    expect(calls[0]?.polyphonic).toBe(false);
    // The source offset is relative to the clip's timeline origin. At PPQ 4
    // the map changes from 60 to 120 BPM, so one source PPQ spans one second;
    // passing clip.startPpq as the origin would incorrectly start at 0.5 s.
    expect(calls[0]?.samples[0]).toBe(1_000);
    // At 4 PPQ the tempo is 120: 0.2 seconds -> 0.4 PPQ, snapped to 0;
    // one second later ends at 2.4 PPQ, snapped to 2.
    expect(notes).toEqual([{ pitch: 60, velocity: 37, startPpq: 0, durationPpq: 2, channel: 0 }]);
  });

  it('transcribes on the tempo at the clip start and places notes from that grid', async () => {
    let options: { tempoBpm?: number; minNoteDivision?: number } | undefined;
    const notes = await transcribeAudioClip(
      { assetId: 'test-audio', startPpq: 4, lengthPpq: 8, sourceOffsetPpq: 0 },
      60,
      {
        loadAudioAsset: async () => asset(1_000, 8_000, 1),
        transcribe: async (_samples, _sampleRate, _polyphonic, workerOptions) => {
          options = workerOptions;
          // Beats on the 120 BPM grid: 1 -> 0.5 s, 3 -> 1.5 s.
          return {
            ...result([noteEvent(1, 0x9, 64, 90), noteEvent(3, 0x8, 64, 0)]),
            tempoBpm: 120,
          };
        },
      },
      { polyphonic: true, minNoteDivision: 16 },
      [
        { startPpq: 0, bpm: 60 },
        { startPpq: 4, bpm: 120 },
      ],
    );

    expect(options?.tempoBpm).toBe(120);
    expect(options?.minNoteDivision).toBe(16);
    expect(notes).toEqual([{ pitch: 64, velocity: 90, startPpq: 1, durationPpq: 2, channel: 0 }]);
  });

  it('passes high-rate input to the worker for bounded WASM resampling', async () => {
    let call:
      | {
          samples: Float32Array;
          sampleRate: number;
          polyphonic: boolean;
          sourceSampleRate?: number;
        }
      | undefined;
    const notes = await transcribeAudioClip(
      { assetId: 'test-audio', startPpq: 0, lengthPpq: 1, sourceOffsetPpq: 0 },
      60,
      {
        loadAudioAsset: async () => asset(96_000, 96_000, 1),
        transcribe: async (samples, sampleRate, polyphonic, options) => {
          call = { samples, sampleRate, polyphonic, sourceSampleRate: options?.sourceSampleRate };
          return result([]);
        },
      },
      { polyphonic: true },
    );

    expect(notes).toEqual([]);
    expect(call?.sampleRate).toBe(48_000);
    expect(call?.samples.length).toBe(96_000);
    expect(call?.sourceSampleRate).toBe(96_000);
    expect(call?.polyphonic).toBe(true);
  });

  it('forwards the reference request and reports the tuning used', async () => {
    let seen: number | 'auto' | undefined;
    const tunings: number[] = [];
    await transcribeAudioClip(
      { assetId: 'test-audio', startPpq: 0, lengthPpq: 1, sourceOffsetPpq: 0 },
      60,
      {
        loadAudioAsset: async () => asset(1_000, 1_000, 1),
        transcribe: async (_samples, _rate, _poly, options) => {
          seen = options?.referenceHz;
          return { ...result([]), tuning: -0.31 };
        },
      },
      { referenceHz: 'auto', onTuning: (tuning) => tunings.push(tuning) },
    );
    expect(seen).toBe('auto');
    expect(tunings).toEqual([-0.31]);
  });

  it('renders looped clip occurrences through the audible clip seam', async () => {
    const source = asset(10, 20, 1);
    source.channels[0] = Float32Array.from({ length: 20 }, (_, frame) => frame / 20);
    let call: Float32Array | undefined;
    await transcribeAudioClip(
      {
        assetId: 'test-audio',
        startPpq: 0,
        lengthPpq: 4,
        sourceOffsetPpq: 0,
        loopEnabled: true,
        loopLengthPpq: 2,
      },
      60,
      {
        loadAudioAsset: async () => source,
        transcribe: async (samples) => {
          call = samples;
          return result([]);
        },
      },
    );

    expect(call).toBeDefined();
    expect(call).toHaveLength(40);
    expect(call?.[0]).toBeCloseTo(call?.[20] ?? -1, 6);
  });

  it('renders warped windows through the injected warp renderer', async () => {
    const source = asset(10, 40, 1);
    const renderWarp = vi.fn(async (warped: WarpedClipSource, _sampleRate: number) => [
      new Float32Array(warped.lengthFrames).fill(0.25),
    ]);
    let call: Float32Array | undefined;
    await transcribeAudioClip(
      {
        assetId: 'test-audio',
        startPpq: 0,
        lengthPpq: 4,
        sourceOffsetPpq: 0,
        warp: { enabled: true, sourceBpm: 60 },
      },
      60,
      {
        loadAudioAsset: async () => source,
        renderWarp,
        transcribe: async (samples) => {
          call = samples;
          return result([]);
        },
      },
    );

    expect(renderWarp).toHaveBeenCalledTimes(1);
    expect(call).toBeDefined();
    expect(call).toHaveLength(40);
    expect(Array.from(call ?? []).every((sample) => sample === 0.25)).toBe(true);
  });

  it('renders the active comp takes and memoizes each asset load', async () => {
    const takeA = asset(10, 40, 1);
    takeA.channels[0].fill(0.1);
    const takeB = asset(10, 40, 1);
    takeB.channels[0].fill(0.7);
    const assets = new Map([
      ['take-a', takeA],
      ['take-b', takeB],
    ]);
    const loaded: string[] = [];
    const metadataLoaded: string[] = [];
    let call: Float32Array | undefined;
    await transcribeAudioClip(
      {
        assetId: 'take-a',
        startPpq: 0,
        lengthPpq: 4,
        sourceOffsetPpq: 0,
        takes: [
          { assetId: 'take-a', name: 'Take A' },
          { assetId: 'take-b', name: 'Take B' },
        ],
        compSegments: [
          { startPpq: 0, takeIndex: 0 },
          { startPpq: 2, takeIndex: 1 },
        ],
      },
      60,
      {
        loadAudioAsset: async (id) => {
          loaded.push(id);
          return assets.get(id) as LoadedAudioAsset;
        },
        loadAudioAssetMeta: async (id) => {
          metadataLoaded.push(id);
          return (assets.get(id) as LoadedAudioAsset).meta;
        },
        transcribe: async (samples) => {
          call = samples;
          return result([]);
        },
      },
    );

    expect(metadataLoaded.sort()).toEqual(['take-a', 'take-b']);
    expect(loaded.sort()).toEqual(['take-a', 'take-b']);
    expect(call).toBeDefined();
    expect(call?.[5]).toBeCloseTo(0.1, 6);
    expect(call?.[30]).toBeCloseTo(0.7, 6);
  });

  it('rejects a large decoded-source estimate before loading PCM', async () => {
    let audioLoaded = false;
    let transcribeCalled = false;
    await expect(
      transcribeAudioClip({ assetId: 'large', startPpq: 0, lengthPpq: 1, sourceOffsetPpq: 0 }, 60, {
        loadAudioAssetMeta: async () => ({
          id: 'large',
          name: 'large',
          sampleRate: 48_000,
          numChannels: 2,
          numFrames: 100_000_000,
        }),
        loadAudioAsset: async () => {
          audioLoaded = true;
          return asset(48_000, 48_000, 2);
        },
        transcribe: async () => {
          transcribeCalled = true;
          return result([]);
        },
      }),
    ).rejects.toMatchObject({ name: 'PayloadMemoryLimitError' });
    expect(audioLoaded).toBe(false);
    expect(transcribeCalled).toBe(false);
  });

  it('aborts while a warp render is pending before worker dispatch', async () => {
    const controller = new AbortController();
    let resolveWarp!: () => void;
    const warpPending = new Promise<void>((resolve) => {
      resolveWarp = resolve;
    });
    let transcribeCalled = false;
    const renderWarp = vi.fn(async (warped: WarpedClipSource, _sampleRate: number) => {
      await warpPending;
      return [new Float32Array(warped.lengthFrames).fill(0.25)];
    });
    const operation = transcribeAudioClip(
      {
        assetId: 'test-audio',
        startPpq: 0,
        lengthPpq: 1,
        sourceOffsetPpq: 0,
        warp: { enabled: true, sourceBpm: 60 },
      },
      60,
      {
        loadAudioAssetMeta: async () => asset(10, 20, 1).meta,
        loadAudioAsset: async () => asset(10, 20, 1),
        renderWarp,
        transcribe: async () => {
          transcribeCalled = true;
          return result([]);
        },
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(renderWarp).toHaveBeenCalledTimes(1));
    controller.abort();
    resolveWarp();
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(transcribeCalled).toBe(false);
  });

  it('rejects oversized polyphonic windows before slicing or dispatch', async () => {
    let transcribeCalled = false;
    let loadCalled = false;
    const source = asset(48_000, MAX_POLYPHONIC_SAMPLES + 1);
    await expect(
      transcribeAudioClip(
        {
          assetId: 'test-audio',
          startPpq: 0,
          lengthPpq: MAX_POLYPHONIC_SECONDS + 1,
          sourceOffsetPpq: 0,
        },
        60,
        {
          loadAudioAsset: async () => {
            loadCalled = true;
            return source;
          },
          transcribe: async () => {
            transcribeCalled = true;
            return result([]);
          },
        },
        { polyphonic: true },
      ),
    ).rejects.toThrow(`limited to ${MAX_POLYPHONIC_SECONDS} seconds`);
    expect(loadCalled).toBe(false);
    expect(transcribeCalled).toBe(false);
  });

  it('keeps overlapping notes and aborts before worker dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    let transcribeCalled = false;
    await expect(
      transcribeAudioClip(
        { assetId: 'test-audio', startPpq: 0, lengthPpq: 1, sourceOffsetPpq: 0 },
        60,
        {
          loadAudioAsset: async () => asset(48_000, 48_000),
          transcribe: async () => {
            transcribeCalled = true;
            return result([]);
          },
        },
        { polyphonic: true, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(transcribeCalled).toBe(false);
  });
});
