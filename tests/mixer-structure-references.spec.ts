import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setMidiCcBinding } from '@/project/command/midi-bindings';
import { addVcaGroup, removeVcaGroup, setTrackVca } from '@/project/command/mixer-vca';
import {
  addAudioTrack,
  addMixerBus,
  applyMixerSceneJson,
  clearHistory,
  removeMixerBus,
  setSend,
  setStripOutputBus,
} from '@/project/commands';
import {
  midiLearnBusStripControlTargetId,
  midiLearnSendTargetId,
  midiLearnVcaTargetId,
} from '@/project/midi-learn-targets';
import { loadProjectDocument, serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('mixer structure removal and replacement', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    trackId = addAudioTrack({ name: 'B' });
  });

  function routeThroughStructure(): { busId: string; groupId: string } {
    const busId = addMixerBus();
    const groupId = addVcaGroup();
    setSend(trackId, busId, { levelDb: -6 });
    setStripOutputBus(trackId, busId);
    setTrackVca(trackId, groupId);
    setMidiCcBinding(midiLearnVcaTargetId(groupId, 'gain'), { channel: 0, controller: 20 });
    setMidiCcBinding(midiLearnSendTargetId(trackId, busId), { channel: 0, controller: 21 });
    setMidiCcBinding(midiLearnBusStripControlTargetId(busId, 'width'), {
      channel: 0,
      controller: 22,
    });
    return { busId, groupId };
  }

  const strip = (): ReturnType<typeof useProjectStore>['tracks'][number] =>
    store.tracks.find((track) => track.id === trackId) as never;

  it('applying a scene scrubs buses, VCA membership and learn bindings it replaced', async () => {
    routeThroughStructure();
    applyMixerSceneJson(
      JSON.stringify({
        strips: [{ id: `track-${store.tracks[0].id}` }],
        buses: [{ id: 'verb' }],
      }),
    );
    const untouched = strip();
    expect(store.mixer.buses.map((bus) => bus.id)).toEqual(['verb']);
    expect(untouched.mixer?.sends ?? []).toEqual([]);
    expect(untouched.mixer?.outputBusId).toBeUndefined();
    expect(untouched.vcaId).toBeUndefined();
    expect([...store.midiCcBindings.keys()]).toEqual([]);
    await expect(loadProjectDocument(serializeProject())).resolves.not.toThrow();
  });

  it('removing a bus drops its sends, routes and learn bindings', () => {
    const { busId, groupId } = routeThroughStructure();
    removeMixerBus(busId);
    expect(strip().mixer?.sends ?? []).toEqual([]);
    expect(strip().mixer?.outputBusId).toBeUndefined();
    expect([...store.midiCcBindings.keys()]).toEqual([midiLearnVcaTargetId(groupId, 'gain')]);
  });

  it('removing a VCA group drops its learn bindings so a reused id is not driven', () => {
    const { groupId } = routeThroughStructure();
    removeVcaGroup(groupId);
    expect([...store.midiCcBindings.keys()].some((id) => id.includes(groupId))).toBe(false);
    const reused = addVcaGroup();
    expect(reused).toBe(groupId);
    expect(store.midiCcBindings.has(midiLearnVcaTargetId(reused, 'gain'))).toBe(false);
  });
});
