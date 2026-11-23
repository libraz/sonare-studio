import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioAssetMeta } from '@/persistence/assets';
import { addAudioClip, addAudioTrack, clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';

const wasmModule = vi.hoisted(() => ({
  current: undefined as undefined | Record<string, unknown>,
}));

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  wasmModule.current = fakeModule as unknown as Record<string, unknown>;
  return { ensureWasm: async () => wasmModule.current };
});

const assetStore = vi.hoisted(() => ({
  pending: null as null | ((meta: AudioAssetMeta) => void),
  loadAssetMeta: (id: string) =>
    new Promise<AudioAssetMeta>((resolve) => {
      assetStore.pending = resolve;
      void id;
    }),
  loadAsset: async () => {
    throw new Error('not used');
  },
  audioAssetUri: (assetId: string) => `asset:${assetId}`,
}));
vi.mock('@/persistence/assets', () => assetStore);

const META: AudioAssetMeta = {
  id: 'asset-1',
  name: 'asset-1',
  sampleRate: 48000,
  numChannels: 1,
  numFrames: 96000,
};

describe('addAudioClip across a document change', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('does not place the clip into a document opened while the asset length loads', async () => {
    const trackId = addAudioTrack({ name: 'Audio' });
    const adding = addAudioClip({ trackId, assetId: 'asset-1', name: 'Late' });
    store.dispose();
    await store.init();
    expect(addAudioTrack({ name: 'Audio' })).toBe(trackId);
    const clipsBefore = store.clips.map((clip) => clip.id);
    assetStore.pending?.(META);
    await expect(adding).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.clips.map((clip) => clip.id)).toEqual(clipsBefore);
  });
});
