import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downmixToMono } from '@/lib/audio-channels';
import { clearAudioAssetLeases, isAudioAssetLeased } from '@/persistence/asset-leases';
import { createAudioAssetTransaction } from '@/persistence/asset-transaction';
import { clearAudioAssetCache, loadAsset } from '@/persistence/assets';
import { garbageCollectMedia } from '@/persistence/gc';
import { MAX_EXTERNAL_AUDIO_FILE_BYTES } from '@/persistence/resource-limits';
import { decodeAndIngest, ingestAudioBuffer } from '@/project/audio-import';
import { analyzeAudioTags } from '@/project/audio-tags';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** A short stereo test signal (distinct per channel). */
function stereo(): Float32Array[] {
  return [new Float32Array([1, 0, -1, 0]), new Float32Array([0, 1, 0, -1])];
}

/** The mono mixdown of {@link stereo}, as the analyzers receive it. */
function mono(): Float32Array {
  return downmixToMono(stereo());
}

describe('ingestAudioBuffer', () => {
  beforeEach(() => {
    installMockOpfs();
    clearAudioAssetCache();
  });

  afterEach(() => {
    uninstallMockOpfs();
    clearAudioAssetCache();
  });

  it('saves the buffers as an asset, preserving stereo', async () => {
    const meta = await ingestAudioBuffer(stereo(), 44100, 'My take', { analysis: null });
    expect(meta).toMatchObject({
      name: 'My take',
      sampleRate: 44100,
      numChannels: 2,
      numFrames: 4,
    });
    clearAudioAssetCache();
    const loaded = await loadAsset(meta.id);
    expect(loaded.channels).toEqual(stereo());
  });

  it('runs the provided analysis functions and stores their tags', async () => {
    const detectBpm = vi.fn(() => 123.5);
    const detectKey = vi.fn(() => ({ name: 'A minor', shortName: 'Am' }));
    const lufs = vi.fn(() => ({ integratedLufs: -14.2 }));
    const meta = await ingestAudioBuffer(stereo(), 44100, 'Loop', {
      analysis: { detectBpm, detectKey, lufs },
    });
    expect(meta.tags).toEqual({ bpm: 123.5, key: 'Am', lufs: -14.2 });
    // Analysis sees a mono mixdown at the asset rate.
    expect(detectBpm).toHaveBeenCalledWith(downmixToMono(stereo()), 44100);
    expect(detectKey).toHaveBeenCalledWith(downmixToMono(stereo()), 44100, { tuning: 'auto' });
    expect(lufs).toHaveBeenCalledWith(downmixToMono(stereo()), 44100);
  });

  it('uses detailed analyzeBpm, key candidates and rhythm tags when available', async () => {
    const analyzeBpm = vi.fn(() => ({ bpm: 128, confidence: 0.82 }));
    const detectBpm = vi.fn(() => 95);
    const detectKeyCandidates = vi.fn(() => [
      { key: { name: 'D minor', shortName: 'Dm', confidence: 0.74 } },
    ]);
    const analyzeRhythm = vi.fn(() => ({
      bpm: 127,
      timeSignature: { numerator: 7, denominator: 8, confidence: 0.66 },
      grooveType: 'breakbeat',
    }));
    const meta = await ingestAudioBuffer(stereo(), 44100, 'Detailed loop', {
      analysis: { analyzeBpm, detectBpm, detectKeyCandidates, analyzeRhythm },
    });

    expect(meta.tags).toEqual({
      bpm: 128,
      bpmConfidence: 0.82,
      key: 'Dm',
      keyConfidence: 0.74,
      timeSignature: '7/8',
      timeSignatureConfidence: 0.66,
      grooveType: 'breakbeat',
    });
    expect(detectBpm).not.toHaveBeenCalled();
    clearAudioAssetCache();
    expect((await loadAsset(meta.id)).meta.tags).toEqual(meta.tags);
  });

  it('stores rhythm, dynamics and timbre tags for the asset inspector', async () => {
    const meta = await ingestAudioBuffer(stereo(), 44100, 'Detailed analysis', {
      analysis: {
        analyzeRhythm: () => ({
          timeSignature: { numerator: 4, denominator: 4, confidence: 0.7 },
          syncopation: 0.42,
          grooveType: 'straight',
          patternRegularity: 0.86,
          tempoStability: 0.93,
        }),
        analyzeDynamics: () => ({
          dynamicRangeDb: 9.5,
          peakDb: -1.2,
          rmsDb: -15.4,
          crestFactor: 14.2,
          loudnessRangeDb: 5.1,
          isCompressed: false,
        }),
        analyzeTimbre: () => ({
          brightness: 0.61,
          warmth: 0.33,
          density: 0.74,
          roughness: 0.12,
          complexity: 0.47,
        }),
      },
    });

    expect(meta.tags).toEqual({
      timeSignature: '4/4',
      timeSignatureConfidence: 0.7,
      syncopation: 0.42,
      grooveType: 'straight',
      patternRegularity: 0.86,
      tempoStability: 0.93,
      dynamicRangeDb: 9.5,
      peakDb: -1.2,
      rmsDb: -15.4,
      crestFactor: 14.2,
      loudnessRangeDb: 5.1,
      isCompressed: false,
      brightness: 0.61,
      warmth: 0.33,
      density: 0.74,
      roughness: 0.12,
      complexity: 0.47,
    });
    clearAudioAssetCache();
    expect((await loadAsset(meta.id)).meta.tags).toEqual(meta.tags);
  });

  it('reports progress after every step, ending at one', async () => {
    const fractions: number[] = [];
    await ingestAudioBuffer(stereo(), 44100, 'Progress', {
      analysis: { detectBpm: () => 120 },
      onProgress: (fraction) => fractions.push(fraction),
    });
    expect(fractions).toHaveLength(6);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions.at(-1)).toBe(1);
  });

  it('falls back to rhythm bpm when no tempo detector succeeds', () => {
    expect(
      analyzeAudioTags(mono(), 44100, {
        analyzeBpm: () => {
          throw new Error('boom');
        },
        analyzeRhythm: () => ({ bpm: 110 }),
      }),
    ).toEqual({ bpm: 110 });
  });

  it('persists a loudness-only measurement (no bpm/key detected)', async () => {
    const meta = await ingestAudioBuffer(stereo(), 44100, 'Loud loop', {
      analysis: { lufs: () => ({ integratedLufs: -11.7 }) },
    });
    expect(meta.tags).toEqual({ lufs: -11.7 });
    clearAudioAssetCache(); // force the OPFS read path
    const loaded = await loadAsset(meta.id);
    expect(loaded.meta.tags).toEqual({ lufs: -11.7 });
  });

  it('persists rhythm, dynamics, timbre and caller tags without bpm/key/lufs', async () => {
    const meta = await ingestAudioBuffer(stereo(), 44100, 'Untuned one-shot', {
      analysis: {
        analyzeRhythm: () => ({
          timeSignature: { numerator: 5, denominator: 8, confidence: 0.73 },
          syncopation: 0.58,
          grooveType: 'broken',
        }),
        analyzeDynamics: () => ({
          dynamicRangeDb: 12.4,
          peakDb: -0.8,
          rmsDb: -16.2,
          crestFactor: 11.1,
          loudnessRangeDb: 4.6,
          isCompressed: false,
        }),
        analyzeTimbre: () => ({
          brightness: 0.68,
          warmth: 0.21,
          density: 0.76,
          roughness: 0.19,
          complexity: 0.49,
        }),
      },
      tags: { form: 'custom-one-shot', grooveType: 'custom-groove' },
    });

    expect(meta.tags).toEqual({
      timeSignature: '5/8',
      timeSignatureConfidence: 0.73,
      syncopation: 0.58,
      grooveType: 'custom-groove',
      dynamicRangeDb: 12.4,
      peakDb: -0.8,
      rmsDb: -16.2,
      crestFactor: 11.1,
      loudnessRangeDb: 4.6,
      isCompressed: false,
      brightness: 0.68,
      warmth: 0.21,
      density: 0.76,
      roughness: 0.19,
      complexity: 0.49,
      form: 'custom-one-shot',
    });
    clearAudioAssetCache();
    expect((await loadAsset(meta.id)).meta.tags).toEqual(meta.tags);
  });

  it('caller tags win over detected ones', async () => {
    const meta = await ingestAudioBuffer(stereo(), 44100, 'Loop', {
      analysis: { detectBpm: () => 100 },
      tags: { bpm: 95 },
    });
    expect(meta.tags).toEqual({ bpm: 95 });
  });

  it('leaves the asset untagged when the analysis worker cannot run', async () => {
    // jsdom has no Worker, so the default path fails to start and imports anyway.
    const meta = await ingestAudioBuffer(stereo(), 44100, 'Plain');
    expect(meta.tags).toBeUndefined();
  });

  it('tolerates throwing or useless detectors', async () => {
    const meta = await ingestAudioBuffer(stereo(), 44100, 'Rough', {
      analysis: {
        detectBpm: () => {
          throw new Error('boom');
        },
        detectKey: () => ({ name: '' }),
      },
    });
    expect(meta.tags).toBeUndefined();
  });

  it('honors an explicit asset id', async () => {
    const meta = await ingestAudioBuffer(stereo(), 48000, 'Named', {
      id: 'fixed-id',
      analysis: null,
    });
    expect(meta.id).toBe('fixed-id');
  });
});

describe('ingestAudioBuffer under an asset transaction', () => {
  beforeEach(() => {
    installMockOpfs();
    clearAudioAssetCache();
    clearAudioAssetLeases();
  });

  afterEach(() => {
    clearAudioAssetLeases();
    uninstallMockOpfs();
    clearAudioAssetCache();
  });

  it('leases the asset before the store write and keeps it from GC until commit', async () => {
    const transaction = createAudioAssetTransaction();
    let leasedAtResolve = false;
    const meta = await ingestAudioBuffer(stereo(), 44100, 'Imported', {
      analysis: null,
      save: (input, audio) =>
        transaction.save(
          {
            ...input,
            onIdResolved: (assetId) => {
              leasedAtResolve = isAudioAssetLeased(assetId);
            },
          },
          audio,
        ),
    });

    expect(leasedAtResolve).toBe(true);
    expect((await garbageCollectMedia()).removedAssetIds).not.toContain(meta.id);
    expect((await loadAsset(meta.id)).meta.name).toBe('Imported');

    transaction.commit();
    expect((await garbageCollectMedia()).removedAssetIds).toContain(meta.id);
  });
});

describe('decodeAndIngest', () => {
  it('rejects an oversized compressed input before reading it into memory', async () => {
    const arrayBuffer = vi.fn();
    const file = {
      size: MAX_EXTERNAL_AUDIO_FILE_BYTES + 1,
      arrayBuffer,
    } as unknown as Blob;

    await expect(decodeAndIngest(file)).rejects.toThrow(/compressed-file limit/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

describe('analyzeAudioTags', () => {
  it('returns empty tags without analysis functions or audio', () => {
    expect(analyzeAudioTags(mono(), 44100, null)).toEqual({});
    expect(analyzeAudioTags(new Float32Array(0), 44100, { detectBpm: () => 120 })).toEqual({});
  });

  it('drops non-finite or non-positive bpm results', () => {
    expect(analyzeAudioTags(mono(), 44100, { detectBpm: () => 0 })).toEqual({});
    expect(analyzeAudioTags(mono(), 44100, { detectBpm: () => Number.NaN })).toEqual({});
  });

  it('prefers the key shortName and falls back to name', () => {
    expect(
      analyzeAudioTags(mono(), 44100, { detectKey: () => ({ name: 'C major', shortName: 'C' }) }),
    ).toEqual({ key: 'C' });
    expect(analyzeAudioTags(mono(), 44100, { detectKey: () => ({ name: 'C major' }) })).toEqual({
      key: 'C major',
    });
  });

  it('stores a finite integrated loudness and drops a silent -Infinity', () => {
    expect(analyzeAudioTags(mono(), 44100, { lufs: () => ({ integratedLufs: -14.2 }) })).toEqual({
      lufs: -14.2,
    });
    expect(
      analyzeAudioTags(mono(), 44100, {
        lufs: () => ({ integratedLufs: Number.NEGATIVE_INFINITY }),
      }),
    ).toEqual({});
  });
});

describe('decodeAndIngest', () => {
  it('fails with a clear error when OfflineAudioContext is unavailable (jsdom)', async () => {
    await expect(decodeAndIngest(new ArrayBuffer(8))).rejects.toThrow(/OfflineAudioContext/);
  });

  it('rejects an oversized decoded buffer before copying channel data', async () => {
    const getChannelData = vi.fn();
    const decodeAudioData = vi.fn(
      async () =>
        ({
          numberOfChannels: 2,
          length: 33_554_433,
          sampleRate: 48_000,
          getChannelData,
        }) as AudioBuffer,
    );
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData = decodeAudioData;
      },
    );

    await expect(decodeAndIngest(new ArrayBuffer(8))).rejects.toThrow(/Decoded audio sample count/);
    expect(getChannelData).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
