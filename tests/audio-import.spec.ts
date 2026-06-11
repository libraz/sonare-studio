import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAudioAssetCache, loadAsset } from '@/persistence/assets';
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
    const meta = await ingestAudioBuffer(stereo(), 44100, 'Loop', {
      analysis: { detectBpm, detectKey },
    });
    expect(meta.tags).toEqual({ bpm: 123.5, key: 'Am' });
    // Analysis sees a mono mixdown at the asset rate.
    expect(detectBpm).toHaveBeenCalledWith(mixdownToMono(stereo()), 44100);
    expect(detectKey).toHaveBeenCalledWith(mixdownToMono(stereo()), 44100);
  });

  it('caller tags win over detected ones', async () => {
    const meta = await ingestAudioBuffer(stereo(), 44100, 'Loop', {
      analysis: { detectBpm: () => 100 },
      tags: { bpm: 95 },
    });
    expect(meta.tags).toEqual({ bpm: 95 });
  });

  it('is a graceful no-op when the wasm module exposes no analysis', async () => {
    // The mocked wasm module (fake-wasm) has no detectBpm/detectKey.
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
});
