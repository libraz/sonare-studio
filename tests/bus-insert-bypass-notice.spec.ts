import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Directive } from 'vue';
import InsertRack from '@/components/mixer/InsertRack.vue';
import {
  addInsert,
  addMixerBus,
  clearHistory,
  type MixerStripTarget,
  mixerBusStripTarget,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { en } from '@/ui/i18n/en';
import { ja } from '@/ui/i18n/ja';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

/** Records the tooltip text a v-tooltip binding resolves to on its element. */
const recordTooltip: Directive<HTMLElement, string> = {
  mounted: (el, binding) => {
    el.dataset.tooltip = binding.value;
  },
  updated: (el, binding) => {
    el.dataset.tooltip = binding.value;
  },
};

function mountRack(target: MixerStripTarget) {
  addInsert(target, 'dynamics.compressor');
  return mount(InsertRack, {
    props: { target },
    global: { directives: { tooltip: recordTooltip }, stubs: { MixerKnob: true } },
  });
}

describe('bus insert bypass notice', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('tells a return-bus insert power toggle that it rebuilds the bus chain', async () => {
    const wrapper = mountRack(mixerBusStripTarget(addMixerBus()));
    const power = wrapper.find('.insert-power');
    expect(power.attributes('data-tooltip')).toBe(en.shell.inserts.busBypass);

    await power.trigger('click');
    expect(wrapper.find('.insert-power').attributes('data-tooltip')).toBe(
      en.shell.inserts.busEnable,
    );
  });

  it('keeps the plain bypass wording on a track insert', async () => {
    const wrapper = mountRack(store.tracks[0].id);
    const power = wrapper.find('.insert-power');
    expect(power.attributes('data-tooltip')).toBe(en.shell.inserts.bypass);

    await power.trigger('click');
    expect(wrapper.find('.insert-power').attributes('data-tooltip')).toBe(en.shell.inserts.enable);
  });

  it('has localized bus bypass copy that mentions the chain rebuild', () => {
    expect(en.shell.inserts.busBypass).toBe('Bypass return-bus insert (rebuilds the bus chain)');
    expect(en.shell.inserts.busEnable).toBe('Enable return-bus insert (rebuilds the bus chain)');
    expect(ja.shell.inserts.busBypass).toBe(
      'return bus のインサートをバイパス（bus チェインを再構築）',
    );
    expect(ja.shell.inserts.busEnable).toBe(
      'return bus のインサートを有効化（bus チェインを再構築）',
    );
  });
});
