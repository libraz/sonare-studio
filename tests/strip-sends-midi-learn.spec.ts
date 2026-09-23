import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NumericReadout from '@/components/mixer/NumericReadout.vue';
import StripSends from '@/components/mixer/StripSends.vue';
import { MIDI_LEARN_KEY, useMidiLearn } from '@/composables/useMidiLearn';
import {
  addInsert,
  addMixerBus,
  clearHistory,
  mixerBusStripTarget,
  setSend,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { midiLearnSendTargetId } from '@/ui/midi/midi-learn';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('StripSends MIDI learn', () => {
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

  it('arms and forgets a send level binding from the knob menu', async () => {
    const busId = addMixerBus({ name: 'Verb' });
    const learn = useMidiLearn();
    const targetId = midiLearnSendTargetId(trackId, busId);
    const wrapper = mount(StripSends, {
      props: { target: trackId },
      global: { provide: { [MIDI_LEARN_KEY as symbol]: learn } },
    });

    await wrapper.find('.knob').trigger('contextmenu', { clientX: 5, clientY: 5 });
    const learnButton = wrapper.findAll('.control-menu button').at(-1);
    expect(learnButton?.exists()).toBe(true);
    await learnButton?.trigger('click');
    await wrapper.vm.$nextTick();

    expect(learn.isArmedId(targetId)).toBe(true);
    expect(wrapper.find('.control-menu').exists()).toBe(false);

    learn.handleCc({ channel: 0, controller: 23, value: 96 });
    await wrapper.vm.$nextTick();
    expect(learn.bindingForId(targetId)).toEqual({ channel: 0, controller: 23 });

    await wrapper.find('.knob').trigger('contextmenu', { clientX: 5, clientY: 5 });
    const forgetButton = wrapper.findAll('.control-menu button').at(-1);
    expect(forgetButton?.exists()).toBe(true);
    await forgetButton?.trigger('click');
    await wrapper.vm.$nextTick();

    expect(learn.bindingForId(targetId)).toBeUndefined();
  });

  it('does not expose MIDI learn for the master routing-only sends', async () => {
    addMixerBus({ name: 'Verb' });
    const learn = useMidiLearn();
    const wrapper = mount(StripSends, {
      props: { target: 'master' },
      global: { provide: { [MIDI_LEARN_KEY as symbol]: learn } },
    });

    await wrapper.find('.knob').trigger('contextmenu', { clientX: 5, clientY: 5 });

    expect(wrapper.findAll('.control-menu button')).toHaveLength(2);
  });

  it('creates a send at an exact level from its numeric readout', async () => {
    const busId = addMixerBus({ name: 'Verb' });
    const wrapper = mount(StripSends, { props: { target: trackId } });
    wrapper.getComponent(NumericReadout).vm.$emit('change', -11.5);
    await wrapper.vm.$nextTick();

    expect(store.tracks[0].mixer?.sends).toEqual([{ busId, levelDb: -11.5, enabled: true }]);
  });

  it('warns when an active send targets a latency-bearing return', async () => {
    const busId = addMixerBus({ name: 'Parallel comp' });
    addInsert(mixerBusStripTarget(busId), 'dynamics.limiter', { lookaheadMs: 5 });
    setSend(trackId, busId, { levelDb: -12 });

    const wrapper = mount(StripSends, { props: { target: trackId } });

    expect(wrapper.find('.send-latency-warning').exists()).toBe(true);
    expect(wrapper.find('.send-latency-warning').attributes('aria-label')).toContain(
      'Send delay compensation is unavailable',
    );
  });

  it('arms send enabled and timing bindings from the row controls', async () => {
    const busId = addMixerBus({ name: 'Verb' });
    setSend(trackId, busId, { levelDb: -12 });
    const learn = useMidiLearn();
    const enabledId = midiLearnSendTargetId(trackId, busId, 'enabled');
    const timingId = midiLearnSendTargetId(trackId, busId, 'timing');
    const wrapper = mount(StripSends, {
      props: { target: trackId },
      global: { provide: { [MIDI_LEARN_KEY as symbol]: learn } },
    });

    const learnButtons = wrapper.findAll('.send-midi-learn');
    expect(learnButtons.length).toBeGreaterThanOrEqual(2);

    await learnButtons[0].trigger('click');
    expect(learn.isArmedId(enabledId)).toBe(true);

    learn.handleCc({ channel: 0, controller: 31, value: 0 });
    await wrapper.vm.$nextTick();
    expect(learn.bindingForId(enabledId)).toEqual({ channel: 0, controller: 31 });
    expect(store.tracks[0].mixer?.sends[0].enabled).toBe(false);

    await learnButtons[1].trigger('click');
    expect(learn.isArmedId(timingId)).toBe(true);
  });
});
