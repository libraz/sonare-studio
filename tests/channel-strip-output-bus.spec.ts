import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChannelStrip from '@/components/mixer/ChannelStrip.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import {
  addGroupTrack,
  addMixerBus,
  clearHistory,
  setStripOutputBus,
  setTrackGroup,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Mounts a channel strip with the heavy children stubbed but SelectMenu real. */
function mountStrip(target: number | 'master') {
  return mount(ChannelStrip, {
    props: { target },
    global: {
      stubs: {
        InsertRack: true,
        StripEqSection: true,
        StripSends: true,
        StripMeter: true,
        MixerFader: true,
        MixerKnob: true,
      },
    },
  });
}

describe('ChannelStrip output-bus selector', () => {
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

  it('hides the selector until a send bus exists', () => {
    const wrapper = mountStrip(trackId);
    expect(wrapper.find('.strip-output').exists()).toBe(false);

    addMixerBus({ name: 'FX' });
    const withBus = mountStrip(trackId);
    expect(withBus.find('.strip-output').exists()).toBe(true);
  });

  it('hides the selector on the master strip', () => {
    addMixerBus({ name: 'FX' });
    const wrapper = mountStrip('master');
    expect(wrapper.find('.strip-output').exists()).toBe(false);
  });

  it('hides the selector on group tracks and grouped members', () => {
    addMixerBus({ name: 'FX' });
    const groupId = addGroupTrack();
    setTrackGroup(trackId, groupId);

    expect(mountStrip(groupId).find('.strip-output').exists()).toBe(false);
    expect(mountStrip(trackId).find('.strip-output').exists()).toBe(false);
  });

  it('routes the output to the chosen bus and back to master', async () => {
    const busId = addMixerBus({ name: 'FX' });
    const wrapper = mountStrip(trackId);
    const select = wrapper.findComponent(SelectMenu);

    select.vm.$emit('change', busId);
    await wrapper.vm.$nextTick();
    expect(store.tracks[0].mixer?.outputBusId).toBe(busId);

    select.vm.$emit('change', '');
    await wrapper.vm.$nextTick();
    expect(store.tracks[0].mixer?.outputBusId).toBeUndefined();
  });

  it('reflects an external routing change in the selected value', async () => {
    const busId = addMixerBus({ name: 'FX' });
    const wrapper = mountStrip(trackId);
    setStripOutputBus(trackId, busId);
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(SelectMenu).props('modelValue')).toBe(busId);
  });
});
