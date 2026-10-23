import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addGroupTrack,
  addMixerBus,
  addTrack,
  applyMixerSceneJson,
  clearHistory,
  clearMixerSnapshots,
  recallMixerSnapshot,
  saveMixerSnapshot,
  setMixerBusSolo,
} from '@/project/commands';
import { engineBusCount, MAX_MIXER_BUSES } from '@/project/mixer';
import { serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('return solo keeps its engine slot', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    clearMixerSnapshots();
    await store.init();
  });

  /** Seven buses with the first one soloed: every engine slot is taken. */
  function fillWithSoloedReturn(): void {
    for (let index = 0; index < MAX_MIXER_BUSES - 1; index++) addMixerBus();
    setMixerBusSolo(store.mixer.buses[0].id, true);
  }

  const soloFits = () =>
    !store.mixer.buses.some((bus) => bus.solo) ||
    engineBusCount(store.mixer.buses, store.tracks) <= MAX_MIXER_BUSES;

  it('refuses a bus or a group track that would take the discard slot', () => {
    fillWithSoloedReturn();

    expect(() => addMixerBus()).toThrow(RangeError);
    expect(() => addGroupTrack()).toThrow(RangeError);
    expect(() => addTrack({ kind: 'group' })).toThrow(RangeError);
    expect(store.mixer.buses).toHaveLength(MAX_MIXER_BUSES - 1);
    expect(store.tracks.some((track) => track.kind === 'group')).toBe(false);
    expect(soloFits()).toBe(true);
  });

  it('refuses a snapshot recall that brings a solo back into a full mixer', () => {
    for (let index = 0; index < MAX_MIXER_BUSES - 2; index++) addMixerBus();
    setMixerBusSolo(store.mixer.buses[0].id, true);
    saveMixerSnapshot('A');
    setMixerBusSolo(store.mixer.buses[0].id, false);
    addGroupTrack();
    addGroupTrack();

    expect(() => recallMixerSnapshot('A')).toThrow(RangeError);
    expect(soloFits()).toBe(true);
  });

  it('refuses a scene whose soloed return leaves no discard slot', () => {
    addGroupTrack();
    const buses = Array.from({ length: MAX_MIXER_BUSES - 1 }, (_, index) => ({
      id: `fx-${index}`,
    }));
    const scene = {
      strips: [{ id: 'ret-0', soloed: true }],
      buses,
      connections: [{ source: 'fx-0', destination: 'ret-0' }],
    };

    expect(() => applyMixerSceneJson(JSON.stringify(scene))).toThrow(RangeError);
    expect(soloFits()).toBe(true);
  });

  it('loads a stored full mixer with its unroutable solo cleared', async () => {
    for (let index = 0; index < MAX_MIXER_BUSES - 1; index++) addMixerBus();
    addGroupTrack();
    const doc = serializeProject();
    if (!doc.mixer) throw new Error('missing mixer');
    doc.mixer.buses[0].solo = true;

    await store.loadDocument(doc);

    expect(store.mixer.buses).toHaveLength(MAX_MIXER_BUSES - 1);
    expect(store.mixer.buses.some((bus) => bus.solo)).toBe(false);
  });
});
