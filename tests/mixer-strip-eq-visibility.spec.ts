import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StripEqSection from '@/components/mixer/StripEqSection.vue';
import { MIDI_LEARN_KEY, useMidiLearn } from '@/composables/useMidiLearn';
import type { ScopeFrame, ScopeListener, ScopeSource } from '@/engine/scope';
import { clearHistory, setStripEq } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { MESSAGES } from '@/ui/i18n';
import { closeContextMenu, useContextMenuState } from '@/ui/menu/context-menu';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('StripEqSection scope gating and labels', () => {
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    closeContextMenu();
    await store.init();
    trackId = store.tracks[0].id;
  });

  function makeScope() {
    const listeners = new Set<ScopeListener>();
    const subscribe = vi.fn((listener: ScopeListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const frame: ScopeFrame = { frame: 1, bands: new Float32Array(8), points: new Float32Array() };
    const scope: ScopeSource = { available: true, sampleRate: 48000, latest: frame, subscribe };
    return { scope, subscribe, listeners };
  }

  it('does not subscribe while hidden and subscribes once shown', async () => {
    const { scope, subscribe, listeners } = makeScope();
    const wrapper = mount(StripEqSection, {
      props: { target: trackId, scope, visible: false },
      global: { stubs: { MixerKnob: true }, directives: { tooltip: () => {} } },
    });
    expect(subscribe).not.toHaveBeenCalled();
    await wrapper.setProps({ visible: true });
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);
    await wrapper.setProps({ visible: false });
    expect(listeners.size).toBe(0);
  });

  it('localizes the MIDI learn menu labels', async () => {
    setStripEq(trackId, {
      enabled: true,
      bands: [{ type: 'Peak', frequencyHz: 1000, gainDb: 0, q: 1, enabled: true }],
    });
    const learn = useMidiLearn();
    const wrapper = mount(StripEqSection, {
      props: { target: trackId },
      global: {
        provide: { [MIDI_LEARN_KEY as symbol]: learn },
        stubs: { MixerKnob: true },
        directives: { tooltip: () => {} },
      },
    });
    await wrapper.get('.eq-band-label').trigger('click', { clientX: 1, clientY: 1 });
    const labels = useContextMenuState().items.map((item) => item.label);
    const controls = MESSAGES.en.shell.mixer.controls;
    expect(typeof controls.midiLearnFreq).toBe('string');
    expect(labels).toContain(controls.midiLearnFreq);
    expect(labels).toContain(controls.midiLearnGain);
    expect(labels).toContain(controls.midiLearnQ);
  });
});
