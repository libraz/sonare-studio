import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAudioAssetCache, listAssets, saveAsset } from '@/persistence/assets';
import { garbageCollectMedia } from '@/persistence/gc';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

const leaseSpies = vi.hoisted(() => ({
  leasedAudioAssetIds: vi.fn(),
  leasedFontIds: vi.fn(),
}));

vi.mock('@/persistence/asset-leases', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence/asset-leases')>();
  leaseSpies.leasedAudioAssetIds.mockImplementation(actual.leasedAudioAssetIds);
  leaseSpies.leasedFontIds.mockImplementation(actual.leasedFontIds);
  return { ...actual, ...leaseSpies };
});

async function seedOrphans(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await saveAsset({ id: `orphan-${index}`, name: `Orphan ${index}`, sampleRate: 48000 }, [
      new Float32Array([index + 1]),
    ]);
  }
}

describe('media garbage collection protected-set snapshots', () => {
  beforeEach(() => {
    installMockOpfs();
    clearAudioAssetCache();
    leaseSpies.leasedAudioAssetIds.mockClear();
    leaseSpies.leasedFontIds.mockClear();
  });

  afterEach(() => {
    clearAudioAssetCache();
    uninstallMockOpfs();
  });

  it('snapshots leased ids a fixed number of times regardless of orphan count', async () => {
    await seedOrphans(2);
    await garbageCollectMedia();
    const small = leaseSpies.leasedAudioAssetIds.mock.calls.length;

    leaseSpies.leasedAudioAssetIds.mockClear();
    await seedOrphans(8);
    const result = await garbageCollectMedia();

    expect(result.removedAssetIds).toHaveLength(8);
    expect(leaseSpies.leasedAudioAssetIds.mock.calls.length).toBe(small);
    expect(await listAssets()).toEqual([]);
  });
});
