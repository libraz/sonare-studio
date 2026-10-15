import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChannelStrip from '@/components/mixer/ChannelStrip.vue';
import { MIDI_LEARN_KEY, useMidiLearn } from '@/composables/useMidiLearn';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('ChannelStrip track-state MIDI learn state', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('resolves the learn state once per parameter, not once per binding', async () => {
    const store = useProjectStore();
    const learn = useMidiLearn();
    const armed = vi.spyOn(learn, 'isArmedId');
    const wrapper = mount(ChannelStrip, {
      props: { target: store.tracks[0].id },
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
    expect(armed.mock.calls.length).toBeLessThanOrEqual(2);
    armed.mockClear();
    await wrapper.findAll('.track-state-midi-learn')[0].trigger('click');
    // Arming changes the state, so mute is resolved again; solo stays cached.
    expect(armed.mock.calls.length).toBeLessThanOrEqual(2);
    expect(wrapper.findAll('.track-state-midi-learn')[0].classes()).toContain('armed');
  });
});
