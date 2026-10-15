import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  audioAssetCacheStats,
  clearAudioAssetCache,
  configureAudioAssetCacheByteBudget,
  DEFAULT_AUDIO_ASSET_CACHE_BYTE_BUDGET,
  loadAsset,
  loadAssetMeta,
  saveAsset,
} from '@/persistence/assets';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

const stereo = (): Float32Array[] => [
  new Float32Array([1, 2, 3, 4]),
  new Float32Array([5, 6, 7, 8]),
];

describe('asset save cache retention', () => {
  beforeEach(() => {
    installMockOpfs();
    clearAudioAssetCache();
  });

  afterEach(() => {
    configureAudioAssetCacheByteBudget(DEFAULT_AUDIO_ASSET_CACHE_BYTE_BUDGET);
    clearAudioAssetCache();
    uninstallMockOpfs();
  });

  it('does not cache a deduplicated save of content that is not already cached', async () => {
    const first = await saveAsset({ name: 'First', sampleRate: 48000 }, stereo());
    clearAudioAssetCache();

    await saveAsset({ name: 'Second', sampleRate: 48000 }, stereo());

    expect(audioAssetCacheStats().ids).toEqual([]);
    expect((await loadAssetMeta(first.id, { cache: false })).name).toBe('Second');
  });

  it('refreshes the cached metadata of a deduplicated save without replacing its buffers', async () => {
    const first = await saveAsset({ name: 'First', sampleRate: 48000 }, stereo());
    const cached = await loadAsset(first.id);

    await saveAsset({ name: 'Second', sampleRate: 48000 }, stereo());

    expect((await loadAssetMeta(first.id)).name).toBe('Second');
    expect((await loadAsset(first.id)).channels[0]).toBe(cached.channels[0]);
  });

  it('drops a stale cached entry when the saved content exceeds the cache budget', async () => {
    const first = await saveAsset({ name: 'First', sampleRate: 48000 }, stereo());
    expect(audioAssetCacheStats().ids).toEqual([first.id]);

    configureAudioAssetCacheByteBudget(8);
    await saveAsset({ id: first.id, name: 'First', sampleRate: 48000 }, stereo());

    expect(audioAssetCacheStats()).toMatchObject({ entries: 0, bytes: 0 });
  });
});
