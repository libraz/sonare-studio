import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAudioAssetLeases, isAudioAssetLeased } from '@/persistence/asset-leases';
import { createAudioAssetTransaction } from '@/persistence/asset-transaction';
import { clearAudioAssetCache, listAssets, loadAssetMeta, saveAsset } from '@/persistence/assets';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

describe('audio asset transaction', () => {
  beforeEach(() => {
    installMockOpfs();
    clearAudioAssetCache();
    clearAudioAssetLeases();
  });

  afterEach(() => {
    clearAudioAssetLeases();
    clearAudioAssetCache();
    uninstallMockOpfs();
  });

  it('holds a lease from save through project commit', async () => {
    const transaction = createAudioAssetTransaction();
    const meta = await transaction.save({ name: 'Rendered', sampleRate: 4 }, [
      new Float32Array([1, 2, 3, 4]),
    ]);

    expect(isAudioAssetLeased(meta.id)).toBe(true);
    transaction.commit();
    expect(isAudioAssetLeased(meta.id)).toBe(false);
    expect((await loadAssetMeta(meta.id)).name).toBe('Rendered');
  });

  it('removes newly-created content on rollback', async () => {
    const transaction = createAudioAssetTransaction();
    const meta = await transaction.save({ name: 'Temporary', sampleRate: 4 }, [
      new Float32Array([1, 2]),
    ]);

    await transaction.rollback();

    expect(isAudioAssetLeased(meta.id)).toBe(false);
    expect(await listAssets()).toEqual([]);
  });

  it('never deletes deduplicated content created by another operation', async () => {
    const existing = await saveAsset({ name: 'Existing', sampleRate: 4 }, [
      new Float32Array([1, 2]),
    ]);
    const transaction = createAudioAssetTransaction();
    const reused = await transaction.save({ name: 'Reuse', sampleRate: 4 }, [
      new Float32Array([1, 2]),
    ]);

    await transaction.rollback();

    expect(reused.id).toBe(existing.id);
    expect((await listAssets()).map((asset) => asset.id)).toEqual([existing.id]);
  });
});
