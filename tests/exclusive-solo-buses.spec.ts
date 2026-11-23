import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setExclusiveTrackSolo } from '@/project/command/tracks';
import { addMixerBus, clearHistory, setMixerBusSolo } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('setExclusiveTrackSolo', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('clears return-bus solos along with track and VCA solos', () => {
    const store = useProjectStore();
    addMixerBus();
    setMixerBusSolo(store.mixer.buses[0].id, true);
    expect(store.mixer.buses.some((bus) => bus.solo === true)).toBe(true);

    setExclusiveTrackSolo(store.tracks[0].id);

    expect(store.mixer.buses.some((bus) => bus.solo === true)).toBe(false);
    expect(store.tracks.filter((track) => track.solo).map((track) => track.id)).toEqual([
      store.tracks[0].id,
    ]);
  });
});
