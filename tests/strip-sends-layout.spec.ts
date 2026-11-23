import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StripSends from '@/components/mixer/StripSends.vue';
import { MIDI_LEARN_KEY, useMidiLearn } from '@/composables/useMidiLearn';
import { addMixerBus, clearHistory, setSend } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('StripSends row layout', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  // A strip is 96px wide: a send's name, timing, level knob, readout, remove
  // and MIDI learn buttons cannot share one line, so each group has its own.
  it('splits an existing send into head, level and learn lines', () => {
    const busId = addMixerBus({ name: 'Verb' });
    const trackId = useProjectStore().tracks[0].id;
    setSend(trackId, busId, { levelDb: -6, enabled: true });
    const wrapper = mount(StripSends, {
      props: { target: trackId },
      global: { provide: { [MIDI_LEARN_KEY as symbol]: useMidiLearn() } },
    });

    const head = wrapper.find('.send-head');
    const body = wrapper.find('.send-body');
    const learn = wrapper.find('.send-learn');
    for (const selector of ['.send-name', '.send-timing', '.send-remove']) {
      expect(head.find(selector).exists()).toBe(true);
    }
    expect(body.find('.knob').exists()).toBe(true);
    expect(body.find('.send-readout').exists()).toBe(true);
    expect(learn.findAll('.send-midi-learn')).toHaveLength(2);
    expect(head.find('.send-midi-learn').exists()).toBe(false);
    expect(body.find('.send-midi-learn').exists()).toBe(false);
  });
});
