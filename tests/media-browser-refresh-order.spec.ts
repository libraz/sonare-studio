import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MediaBrowser from '@/components/media/MediaBrowser.vue';
import type { AudioAssetMeta } from '@/persistence/assets';

const assetStore = vi.hoisted(() => ({
  listAssets: vi.fn<() => Promise<AudioAssetMeta[]>>(),
  loadAsset: vi.fn(),
  deleteAsset: vi.fn(),
  deleteAssetUnlocked: vi.fn(),
}));
vi.mock('@/persistence/assets', () => assetStore);
vi.mock('@/project/audio-import', () => ({ decodeAndIngest: vi.fn() }));
vi.mock('@/project/commands', () => ({
  collectHistoryReferencedMediaIds: () => ({ assetIds: new Set(), fontIds: new Set() }),
}));
vi.mock('@/lib/wasm', () => ({ ensureWasm: vi.fn(async () => ({})) }));

function meta(id: string, name: string): AudioAssetMeta {
  return { id, name, sampleRate: 48000, numChannels: 1, numFrames: 8 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('MediaBrowser asset list refresh order', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('keeps the newest list when an older refresh settles last', async () => {
    const older = deferred<AudioAssetMeta[]>();
    const newer = deferred<AudioAssetMeta[]>();
    assetStore.listAssets.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const wrapper = mount(MediaBrowser, { props: { visible: false } });
    await wrapper.setProps({ visible: true });

    newer.resolve([meta('b', 'Newer')]);
    await flushPromises();
    older.resolve([meta('a', 'Older')]);
    await flushPromises();

    const names = wrapper.findAll('.asset-row').map((row) => row.text());
    expect(names.some((text) => text.includes('Newer'))).toBe(true);
    expect(names.some((text) => text.includes('Older'))).toBe(false);
  });
});
