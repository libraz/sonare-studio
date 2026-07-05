import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChannelStrip from '@/components/mixer/ChannelStrip.vue';
import { MIDI_LEARN_KEY, useMidiLearn } from '@/composables/useMidiLearn';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { midiLearnTrackStateTargetId } from '@/ui/midi/midi-learn';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('ChannelStrip MIDI learn', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    trackId = store.tracks[0].id;
  });

  it('arms mute and solo bindings from the track state buttons', async () => {
    const learn = useMidiLearn();
    const wrapper = mount(ChannelStrip, {
      props: { target: trackId },
      global: {
        provide: { [MIDI_LEARN_KEY as symbol]: learn },
        stubs: {
          InsertRack: true,
          StripEqSection: true,
          StripSends: true,
          StripMeter: true,
          MixerFader: true,
          MixerKnob: true,
          StripOptionsPopover: true,
        },
      },
    });
    const muteId = midiLearnTrackStateTargetId(trackId, 'mute');
    const soloId = midiLearnTrackStateTargetId(trackId, 'solo');

    const buttons = wrapper.findAll('.track-state-midi-learn');
    expect(buttons).toHaveLength(2);
    await buttons[0].trigger('click');
    expect(learn.isArmedId(muteId)).toBe(true);

    learn.handleCc({ channel: 0, controller: 33, value: 127 });
    await wrapper.vm.$nextTick();
    expect(learn.bindingForId(muteId)).toEqual({ channel: 0, controller: 33 });
    expect(store.tracks[0].mute).toBe(true);

    await buttons[1].trigger('click');
    expect(learn.isArmedId(soloId)).toBe(true);
  });
});
