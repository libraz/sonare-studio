import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioAssetMeta, LoadedAudioAsset } from '@/persistence/assets';
import {
  addAudioClip,
  addAudioTrack,
  clearHistory,
  detectChordsFromAudioClip,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';

const wasmModule = vi.hoisted(() => ({
  current: undefined as undefined | Record<string, unknown>,
}));

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  wasmModule.current = createFakeWasmModule() as unknown as Record<string, unknown>;
  return { ensureWasm: async () => wasmModule.current };
});

const assetStore = vi.hoisted(() => ({
  loadAssetMeta: vi.fn<(id: string) => Promise<AudioAssetMeta>>(),
  loadAsset: vi.fn<(id: string) => Promise<LoadedAudioAsset>>(),
  audioAssetUri: (assetId: string) => `asset:${assetId}`,
}));
vi.mock('@/persistence/assets', () => assetStore);

function loadedAsset(): LoadedAudioAsset {
  return {
    meta: { id: 'asset-1', name: 'asset-1', sampleRate: 48000, numChannels: 1, numFrames: 96000 },
    channels: [new Float32Array(96000).fill(0.5)],
  };
}

describe('detectChordsFromAudioClip abort', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
    await store.init();
  });

  it('rejects with an AbortError and merges nothing when aborted while loading', async () => {
    let resolve!: (asset: LoadedAudioAsset) => void;
    assetStore.loadAsset.mockReturnValueOnce(
      new Promise<LoadedAudioAsset>((res) => {
        resolve = res;
      }),
    );
    Object.assign(wasmModule.current ?? {}, {
      detectChords: () => ({ chords: [{ root: 0, bass: 0, quality: 0, start: 0, end: 1 }] }),
    });
    const trackId = addAudioTrack({ name: 'Audio' });
    const clipId = await addAudioClip({
      trackId,
      assetId: 'asset-1',
      lengthPpq: 4,
      name: 'Source',
    });
    const controller = new AbortController();

    const detection = detectChordsFromAudioClip(clipId, controller.signal);
    const outcome = expect(detection).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    resolve(loadedAsset());
    await outcome;

    expect(store.chords).toEqual([]);
  });
});
