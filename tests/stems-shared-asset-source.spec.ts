import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAudioAssetCache, saveAsset } from '@/persistence/assets';
import {
  addAudioClip,
  addAudioTrack,
  clearHistory,
  splitAudioClipToComponents,
} from '@/project/commands';
import { getProject, useProjectStore } from '@/project/store';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('separated stems with identical audio', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    clearAudioAssetCache();
    await store.init();
  });

  afterEach(() => {
    uninstallMockOpfs();
    clearAudioAssetCache();
  });

  it('register one Project source for the asset they share', async () => {
    installMockOpfs();
    await saveAsset({ id: 'stem-source', name: 'Stem Source', sampleRate: 4 }, [
      new Float32Array([1, 2, 3, 4]),
    ]);
    const trackId = addAudioTrack({ name: 'Audio' });
    const clipId = await addAudioClip({
      trackId,
      assetId: 'stem-source',
      lengthPpq: 2,
      name: 'Loop',
    });

    const ids = await splitAudioClipToComponents(clipId, 2, {
      decompose: async (channels) => [
        channels.map((c) => c.slice()),
        channels.map((c) => c.slice()),
      ],
    });

    const assets = ids.map((id) => store.clips.find((clip) => clip.id === id)?.assetId);
    expect(assets[0]).toBeDefined();
    expect(assets[1]).toBe(assets[0]);
    const doc = JSON.parse(getProject().toJson()) as {
      clips: Array<{ id: number; sourceId: number }>;
    };
    const sourceIds = ids.map((id) => doc.clips.find((clip) => clip.id === id)?.sourceId);
    expect(sourceIds[0]).toBeGreaterThan(0);
    expect(sourceIds[1]).toBe(sourceIds[0]);
  });
});
