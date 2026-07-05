import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StripOptionsPopover from '@/components/mixer/StripOptionsPopover.vue';
import { MIDI_LEARN_KEY, useMidiLearn } from '@/composables/useMidiLearn';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { midiLearnStripControlTargetId } from '@/ui/midi/midi-learn';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('StripOptionsPopover MIDI learn', () => {
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

  it('arms and forgets a strip-local control binding from the popover', async () => {
    const learn = useMidiLearn();
    const wrapper = mount(StripOptionsPopover, {
      props: { target: trackId, name: 'Track 1' },
      global: { provide: { [MIDI_LEARN_KEY as symbol]: learn } },
    });
    const targetId = midiLearnStripControlTargetId(trackId, 'inputTrimDb');

    await wrapper.find('.strip-options-btn').trigger('click');
    await wrapper.find('.strip-midi-learn').trigger('click');
    expect(learn.isArmedId(targetId)).toBe(true);

    learn.handleCc({ channel: 0, controller: 24, value: 127 });
    await wrapper.vm.$nextTick();
    expect(learn.bindingForId(targetId)).toEqual({ channel: 0, controller: 24 });
    expect(store.tracks[0].mixer?.inputTrimDb).toBe(48);

    const forget = wrapper.find('.strip-midi-forget');
    expect(forget.exists()).toBe(true);
    await forget.trigger('click');
    expect(learn.bindingForId(targetId)).toBeUndefined();
  });

  it('exposes only master-compatible strip controls on the master strip', async () => {
    const learn = useMidiLearn();
    const wrapper = mount(StripOptionsPopover, {
      props: { target: 'master', name: 'Master' },
      global: { provide: { [MIDI_LEARN_KEY as symbol]: learn } },
    });

    await wrapper.find('.strip-options-btn').trigger('click');

    expect(wrapper.findAll('.strip-midi-learn')).toHaveLength(4);
    expect(wrapper.text()).not.toContain('Delay');
  });

  it('removes the options popover outside-click listener on unmount', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const wrapper = mount(StripOptionsPopover, {
      props: { target: trackId, name: 'Track 1' },
    });

    await wrapper.find('.strip-options-btn').trigger('click');

    expect(add).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    wrapper.unmount();
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
  });

  it('arms a polarity switch binding from the popover', async () => {
    const learn = useMidiLearn();
    const wrapper = mount(StripOptionsPopover, {
      props: { target: trackId, name: 'Track 1' },
      global: { provide: { [MIDI_LEARN_KEY as symbol]: learn } },
    });
    const targetId = midiLearnStripControlTargetId(trackId, 'polarityLeft');

    await wrapper.find('.strip-options-btn').trigger('click');
    const buttons = wrapper.findAll('.strip-midi-learn');
    await buttons[2].trigger('click');
    expect(learn.isArmedId(targetId)).toBe(true);

    learn.handleCc({ channel: 0, controller: 28, value: 127 });
    await wrapper.vm.$nextTick();

    expect(learn.bindingForId(targetId)).toEqual({ channel: 0, controller: 28 });
    expect(store.tracks[0].mixer?.polarityInvertLeft).toBe(true);
  });

  it('arms pan law and pan mode enum bindings from the popover', async () => {
    const learn = useMidiLearn();
    const wrapper = mount(StripOptionsPopover, {
      props: { target: trackId, name: 'Track 1' },
      global: { provide: { [MIDI_LEARN_KEY as symbol]: learn } },
    });
    const panLawId = midiLearnStripControlTargetId(trackId, 'panLaw');
    const panModeId = midiLearnStripControlTargetId(trackId, 'panMode');

    await wrapper.find('.strip-options-btn').trigger('click');
    const buttons = wrapper.findAll('.strip-midi-learn');
    await buttons[5].trigger('click');
    expect(learn.isArmedId(panLawId)).toBe(true);

    learn.handleCc({ channel: 0, controller: 29, value: 127 });
    await wrapper.vm.$nextTick();
    expect(store.tracks[0].mixer?.panLaw).toBe('linear0dB');

    await buttons[6].trigger('click');
    expect(learn.isArmedId(panModeId)).toBe(true);
  });
});
