import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addMixerBus, clearHistory, removeMixerBus, setSend, undo } from '@/project/commands';
import { midiLearnSendTargetId } from '@/project/midi-learn-targets';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('removeMixerBus MIDI-learn send bindings', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('drops send bindings to the removed bus only, and undo restores them', () => {
    const trackId = store.tracks[0].id;
    const removed = addMixerBus();
    const kept = addMixerBus();
    setSend(trackId, removed, { levelDb: -9 });
    setSend(trackId, kept, { levelDb: -9 });
    const removedLevel = midiLearnSendTargetId(trackId, removed, 'level');
    const removedEnabled = midiLearnSendTargetId(trackId, removed, 'enabled');
    const keptLevel = midiLearnSendTargetId(trackId, kept, 'level');
    store.midiCcBindings.set(removedLevel, { channel: 0, controller: 20 });
    store.midiCcBindings.set(removedEnabled, { channel: 0, controller: 21 });
    store.midiCcBindings.set(keptLevel, { channel: 0, controller: 22 });

    removeMixerBus(removed);

    expect([...store.midiCcBindings.keys()]).toEqual([keptLevel]);
    expect(undo()).toBe(true);
    expect(store.midiCcBindings.has(removedLevel)).toBe(true);
    expect(store.midiCcBindings.has(removedEnabled)).toBe(true);
  });
});
