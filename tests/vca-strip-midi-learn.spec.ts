import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import VcaStrip from '@/components/mixer/VcaStrip.vue';
import { MIDI_LEARN_KEY, useMidiLearn } from '@/composables/useMidiLearn';
import { addVcaGroup, clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { midiLearnVcaTargetId } from '@/ui/midi/midi-learn';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('VcaStrip MIDI learn', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    addVcaGroup({ id: 'drums', name: 'Drums' });
  });

  it('arms and drives VCA gain, mute, and solo bindings', async () => {
    const learn = useMidiLearn();
    const wrapper = mount(VcaStrip, {
      props: { group: store.mixer.vcaGroups![0] },
      global: {
        provide: { [MIDI_LEARN_KEY as symbol]: learn },
        stubs: { MixerFader: true },
      },
    });

    const muteId = midiLearnVcaTargetId('drums', 'mute');
    const soloId = midiLearnVcaTargetId('drums', 'solo');
    const gainId = midiLearnVcaTargetId('drums', 'gain');
    const buttons = wrapper.findAll('.vca-midi-learn');
    expect(buttons).toHaveLength(3);

    await buttons[0].trigger('click');
    expect(learn.isArmedId(muteId)).toBe(true);
    learn.handleCc({ channel: 0, controller: 36, value: 127 });
    expect(learn.bindingForId(muteId)).toEqual({ channel: 0, controller: 36 });
    expect(store.mixer.vcaGroups?.[0]?.mute).toBe(true);

    await buttons[1].trigger('click');
    expect(learn.isArmedId(soloId)).toBe(true);
    learn.handleCc({ channel: 0, controller: 37, value: 127 });
    expect(learn.bindingForId(soloId)).toEqual({ channel: 0, controller: 37 });
    expect(store.mixer.vcaGroups?.[0]?.solo).toBe(true);

    await buttons[2].trigger('click');
    expect(learn.isArmedId(gainId)).toBe(true);
    learn.handleCc({ channel: 0, controller: 35, value: 127 });
    expect(learn.bindingForId(gainId)).toEqual({ channel: 0, controller: 35 });
    expect(store.mixer.vcaGroups?.[0]?.gainDb).toBe(6);
  });
});
