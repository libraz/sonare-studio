import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SampleEditor from '@/components/sample-editor/SampleEditor.vue';
import type { AudioAssetMeta, LoadedAudioAsset } from '@/persistence/assets';
import { useProjectStore } from '@/project/store';

const assetStore = vi.hoisted(() => ({
  deleteAsset: vi.fn(async () => undefined),
  listAssets: vi.fn<() => Promise<AudioAssetMeta[]>>(),
  loadAsset: vi.fn<(id: string) => Promise<LoadedAudioAsset>>(),
  saveAsset: vi.fn(),
  saveAssetWithStatus: vi.fn(async (...args: Parameters<typeof assetStore.saveAsset>) => ({
    meta: await assetStore.saveAsset(...args),
    created: true,
  })),
}));
vi.mock('@/persistence/assets', () => assetStore);

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: vi.fn(async () => fakeModule) };
});

/** Builds a manually-resolved promise for async race tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function asset(id: string, name: string): LoadedAudioAsset {
  return {
    meta: {
      id,
      name,
      sampleRate: 48000,
      numChannels: 1,
      numFrames: 16,
    },
    channels: [new Float32Array(16)],
  };
}

function mountEditor(assetId = 'asset-a') {
  return mount(SampleEditor, {
    props: { assetId },
    global: {
      directives: {
        tooltip: () => {},
      },
      stubs: {
        SelectMenu: true,
        ToggleButton: true,
      },
    },
  });
}

describe('SampleEditor async loading', () => {
  beforeEach(async () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    await store.init();
    vi.clearAllMocks();
    assetStore.listAssets.mockResolvedValue([]);
    assetStore.saveAsset.mockResolvedValue({ id: 'saved', name: 'Saved' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('ignores a stale asset load after the editor switches assets', async () => {
    const first = deferred<LoadedAudioAsset>();
    const second = deferred<LoadedAudioAsset>();
    assetStore.loadAsset.mockImplementation((id) =>
      id === 'asset-a' ? first.promise : second.promise,
    );
    const wrapper = mountEditor('asset-a');

    await wrapper.setProps({ assetId: 'asset-b' });
    second.resolve(asset('asset-b', 'Second sample'));
    await flushPromises();
    first.resolve(asset('asset-a', 'First sample'));
    await flushPromises();

    expect(wrapper.find('.asset-name').text()).toBe('Second sample');
  });

  it('does not update the loaded asset after unmount', async () => {
    const pending = deferred<LoadedAudioAsset>();
    assetStore.loadAsset.mockReturnValue(pending.promise);
    const wrapper = mountEditor('asset-a');

    wrapper.unmount();
    pending.resolve(asset('asset-a', 'Detached sample'));
    await flushPromises();

    expect(assetStore.loadAsset).toHaveBeenCalledWith('asset-a');
    expect(wrapper.text()).not.toContain('Detached sample');
  });
});
