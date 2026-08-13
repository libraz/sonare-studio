import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAudioAssetCache, loadAsset } from '@/persistence/assets';
import { MAX_EXTERNAL_AUDIO_FILE_BYTES } from '@/persistence/resource-limits';
import {
  analyzeAudioTags,
  decodeAndIngest,
  ingestAudioBuffer,
  mixdownToMono,
} from '@/project/audio-import';
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
    expect(detectBpm).toHaveBeenCalledWith(mixdownToMono(stereo()), 44100);
    expect(detectKey).toHaveBeenCalledWith(mixdownToMono(stereo()), 44100);
    expect(lufs).toHaveBeenCalledWith(mixdownToMono(stereo()), 44100);
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

  it('stores unified analyze dynamics and timbre tags for the asset inspector', async () => {
    const analyze = vi.fn(() => ({
      bpm: 118,
      bpmConfidence: 0.91,
      key: { name: 'C major', shortName: 'C', confidence: 0.8 },
      timeSignature: { numerator: 4, denominator: 4, confidence: 0.7 },
      rhythm: {
        syncopation: 0.42,
        grooveType: 'straight',
        patternRegularity: 0.86,
        tempoStability: 0.93,
      },
      dynamics: {
        dynamicRangeDb: 9.5,
        peakDb: -1.2,
        rmsDb: -15.4,
        crestFactor: 14.2,
        loudnessRangeDb: 5.1,
        isCompressed: false,
      },
      timbre: {
        brightness: 0.61,
        warmth: 0.33,
        density: 0.74,
        roughness: 0.12,
        complexity: 0.47,
      },
      form: 'verse-chorus',
    }));

    const meta = await ingestAudioBuffer(stereo(), 44100, 'Unified analysis', {
      analysis: { analyze },
    });

    expect(meta.tags).toEqual({
      bpm: 118,
      bpmConfidence: 0.91,
      key: 'C',
      keyConfidence: 0.8,
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
      form: 'verse-chorus',
    });
    expect(analyze).toHaveBeenCalledWith(mixdownToMono(stereo()), 44100);
    clearAudioAssetCache();
    expect((await loadAsset(meta.id)).meta.tags).toEqual(meta.tags);
  });

  it('lets dedicated dynamics and timbre analyzers refine unified analysis tags', () => {
    expect(
      analyzeAudioTags(stereo(), 44100, {
        analyze: () => ({
          dynamics: { dynamicRangeDb: 6 },
          timbre: { brightness: 0.2 },
        }),
        analyzeDynamics: () => ({ dynamicRangeDb: 10, isCompressed: true }),
        analyzeTimbre: () => ({ brightness: 0.8, warmth: 0.4 }),
      }),
    ).toEqual({
      dynamicRangeDb: 10,
      isCompressed: true,
      brightness: 0.8,
      warmth: 0.4,
    });
  });

  it('falls back to rhythm bpm when no tempo detector succeeds', () => {
    expect(
      analyzeAudioTags(stereo(), 44100, {
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
        analyze: () => ({
          rhythm: {
            timeSignature: { numerator: 5, denominator: 8, confidence: 0.73 },
            syncopation: 0.58,
            grooveType: 'broken',
          },
          dynamics: {
            dynamicRangeDb: 12.4,
            peakDb: -0.8,
            rmsDb: -16.2,
            crestFactor: 11.1,
            loudnessRangeDb: 4.6,
            isCompressed: false,
          },
          timbre: {
            brightness: 0.68,
            warmth: 0.21,
            density: 0.76,
            roughness: 0.19,
            complexity: 0.49,
          },
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

  it('persists the default wasm loudness analysis (no bpm/key detector exposed)', async () => {
    // The mocked wasm module (fake-wasm) exposes lufs() but no detectBpm/detectKey,
    // so the default import path stores a loudness-only tag.
    const meta = await ingestAudioBuffer(stereo(), 44100, 'Plain');
    expect(meta.tags?.bpm).toBeUndefined();
    expect(meta.tags?.key).toBeUndefined();
    expect(meta.tags?.lufs).toBeTypeOf('number');
    expect(Number.isFinite(meta.tags?.lufs)).toBe(true);
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
    expect(analyzeAudioTags(stereo(), 44100, null)).toEqual({});
    expect(analyzeAudioTags([], 44100, { detectBpm: () => 120 })).toEqual({});
    expect(analyzeAudioTags([new Float32Array(0)], 44100, { detectBpm: () => 120 })).toEqual({});
  });

  it('drops non-finite or non-positive bpm results', () => {
    expect(analyzeAudioTags(stereo(), 44100, { detectBpm: () => 0 })).toEqual({});
    expect(analyzeAudioTags(stereo(), 44100, { detectBpm: () => Number.NaN })).toEqual({});
  });

  it('prefers the key shortName and falls back to name', () => {
    expect(
      analyzeAudioTags(stereo(), 44100, { detectKey: () => ({ name: 'C major', shortName: 'C' }) }),
    ).toEqual({ key: 'C' });
    expect(analyzeAudioTags(stereo(), 44100, { detectKey: () => ({ name: 'C major' }) })).toEqual({
      key: 'C major',
    });
  });

  it('stores a finite integrated loudness and drops a silent -Infinity', () => {
    expect(analyzeAudioTags(stereo(), 44100, { lufs: () => ({ integratedLufs: -14.2 }) })).toEqual({
      lufs: -14.2,
    });
    expect(
      analyzeAudioTags(stereo(), 44100, {
        lufs: () => ({ integratedLufs: Number.NEGATIVE_INFINITY }),
      }),
    ).toEqual({});
  });
});

describe('mixdownToMono', () => {
  it('averages channels and copies mono input', () => {
    const mono = mixdownToMono(stereo());
    expect(mono).toEqual(new Float32Array([0.5, 0.5, -0.5, -0.5]));
    const single = new Float32Array([1, 2]);
    const copy = mixdownToMono([single]);
    expect(copy).toEqual(single);
    expect(copy).not.toBe(single);
    expect(mixdownToMono([])).toEqual(new Float32Array(0));
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
