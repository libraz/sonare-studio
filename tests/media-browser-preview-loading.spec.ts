import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MediaBrowser from '@/components/media/MediaBrowser.vue';
import { clearAudioAssetLeases } from '@/persistence/asset-leases';
import type { AudioAssetMeta, LoadedAudioAsset } from '@/persistence/assets';
import { asAudioContext, createFakeAudioContext } from './fake-audio-context';

const assetStore = vi.hoisted(() => ({
  listAssets: vi.fn<() => Promise<AudioAssetMeta[]>>(),
  loadAsset: vi.fn<(id: string) => Promise<LoadedAudioAsset>>(),
  deleteAsset: vi.fn(),
  deleteAssetUnlocked: vi.fn(),
}));
vi.mock('@/persistence/assets', () => assetStore);
vi.mock('@/project/audio-import', () => ({ decodeAndIngest: vi.fn() }));
vi.mock('@/project/commands', () => ({
  collectHistoryReferencedMediaIds: () => ({ assetIds: new Set(), fontIds: new Set() }),
}));
vi.mock('@/lib/wasm', () => ({ ensureWasm: vi.fn(async () => ({})) }));

const META: AudioAssetMeta = {
  id: 'a1',
  name: 'Loop',
  sampleRate: 48000,
  numChannels: 1,
  numFrames: 8,
};

function loaded(): LoadedAudioAsset {
  return { meta: META, channels: [new Float32Array(8)] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('MediaBrowser preview loading indicator', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    clearAudioAssetLeases();
    assetStore.listAssets.mockResolvedValue([META]);
  });

  it('keeps the spinner while a newer load of the same asset is pending', async () => {
    const first = deferred<LoadedAudioAsset>();
    const second = deferred<LoadedAudioAsset>();
    assetStore.loadAsset.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const context = createFakeAudioContext();
    const wrapper = mount(MediaBrowser, {
      props: { previewContextFactory: () => asAudioContext(context) },
    });
    await flushPromises();

    const button = wrapper.get('.preview-button');
    await button.trigger('click');
    await button.trigger('click');
    first.resolve(loaded());
    await flushPromises();

    expect(wrapper.find('.preview-spinner').exists()).toBe(true);
    second.resolve(loaded());
    await flushPromises();
    expect(wrapper.find('.preview-spinner').exists()).toBe(false);
  });
});
