import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addAudioTrack, clearHistory, setInsertSidechain } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('setInsertSidechain strip lookup', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('resolves a track without a stored strip like its sibling commands', () => {
    const trackId = addAudioTrack({ name: 'Pad' });
    store.tracks = store.tracks.map((track) => {
      if (track.id !== trackId) return track;
      const { mixer: _mixer, ...rest } = track;
      return rest;
    });

    expect(() => setInsertSidechain(trackId, 0, null)).toThrow(/Unknown insert index/);
  });
});
