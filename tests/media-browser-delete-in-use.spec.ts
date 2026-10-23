import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MediaBrowser from '@/components/media/MediaBrowser.vue';
import { clearAudioAssetLeases } from '@/persistence/asset-leases';
import type { AudioAssetMeta } from '@/persistence/assets';
import { en } from '@/ui/i18n/en';

const assetStore = vi.hoisted(() => {
  const deleteAsset = vi.fn<(id: string) => Promise<void>>(async () => {});
  return {
    listAssets: vi.fn<() => Promise<AudioAssetMeta[]>>(),
    loadAsset: vi.fn(),
    deleteAsset,
    deleteAssetUnlocked: deleteAsset,
  };
});
vi.mock('@/persistence/assets', () => assetStore);
vi.mock('@/project/audio-import', () => ({ decodeAndIngest: vi.fn() }));
vi.mock('@/project/commands', () => ({
  collectHistoryReferencedMediaIds: () => ({ assetIds: new Set(), fontIds: new Set() }),
}));
vi.mock('@/lib/wasm', () => ({ ensureWasm: vi.fn(async () => ({})) }));
vi.mock('@/persistence/opfs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence/opfs')>()),
  isOpfsAvailable: () => true,
}));
// A project saved in storage still uses the asset.
vi.mock('@/persistence/gc', () => ({
  collectReferencedMediaIds: vi.fn(async () => ({
    complete: true,
    assetIds: new Set(['a1']),
    fontIds: new Set(),
  })),
}));

describe('MediaBrowser delete refused by a stored reference', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    clearAudioAssetLeases();
    assetStore.listAssets.mockResolvedValue([
      { id: 'a1', name: 'Loop', sampleRate: 48000, numChannels: 2, numFrames: 48000 },
    ]);
  });

  it('keeps the asset listed and says why', async () => {
    const wrapper = mount(MediaBrowser);
    await flushPromises();
    const rowButton = (selector: string) => {
      const row = wrapper
        .findAll('.asset-row')
        .find((r) => r.find('.asset-name').text() === 'Loop');
      if (!row) throw new Error('row not found');
      return row.find(selector);
    };

    await rowButton('.delete-button').trigger('click');
    await rowButton('.danger').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('.error').exists()).toBe(true));

    expect(assetStore.deleteAsset).not.toHaveBeenCalled();
    expect(wrapper.find('.error').text()).toBe(en.shell.media.deleteInUse);
    expect(wrapper.findAll('.asset-name').map((n) => n.text())).toEqual(['Loop']);
  });
});
