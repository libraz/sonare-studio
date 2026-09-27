import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChannelStrip from '@/components/mixer/ChannelStrip.vue';
import NumericReadout from '@/components/mixer/NumericReadout.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import type { MeterSource, StereoMeterLevels } from '@/engine/meters';
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

function meterSource(levels: Partial<StereoMeterLevels>): MeterSource {
  return {
    latest: {
      frame: 0,
      peakDbL: -12,
      peakDbR: -12,
      rmsDbL: -18,
      rmsDbR: -18,
      correlation: 0,
      ...levels,
    },
    subscribe: () => () => {},
  };
}

/** Mounts a channel strip with the heavy children stubbed but SelectMenu real. */
function mountStrip(target: number | 'master', bridge: MeterSource | null = null) {
  return mount(ChannelStrip, {
    props: { target, bridge },
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

  it('hides sends on the master strip because master sends are not audible', () => {
    addMixerBus({ name: 'FX' });
    expect(mountStrip(trackId).findComponent({ name: 'StripSends' }).exists()).toBe(true);
    expect(mountStrip('master').findComponent({ name: 'StripSends' }).exists()).toBe(false);
  });

  it('hides the selector on group tracks and grouped members', () => {
    addMixerBus({ name: 'FX' });
    const groupId = addGroupTrack();
    setTrackGroup(trackId, groupId);

    expect(mountStrip(groupId).find('.strip-output').exists()).toBe(false);
    expect(mountStrip(trackId).find('.strip-output').exists()).toBe(false);
  });

  it('shows the EQ section on group tracks and the master', () => {
    const groupId = addGroupTrack();

    expect(mountStrip(trackId).findComponent({ name: 'StripEqSection' }).exists()).toBe(true);
    expect(mountStrip('master').findComponent({ name: 'StripEqSection' }).exists()).toBe(true);
    expect(mountStrip(groupId).findComponent({ name: 'StripEqSection' }).exists()).toBe(true);
  });

  it('shows track gain reduction when the lane meter reports dynamics GR', async () => {
    const wrapper = mountStrip(trackId, meterSource({ gainReductionDb: -4 }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.strip-gr-value').text()).toBe('-4.0');
  });

  it('does not render the compact GR meter on the master strip', async () => {
    const wrapper = mountStrip('master', meterSource({ gainReductionDb: -4 }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.strip-gr').exists()).toBe(false);
    expect(wrapper.findComponent({ name: 'MasterMeterReadout' }).exists()).toBe(true);
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

  it('commits exact gain and pan values from the numeric readouts', async () => {
    const wrapper = mountStrip(trackId);
    const readouts = wrapper.findAllComponents(NumericReadout);
    expect(readouts).toHaveLength(2);

    readouts[0].vm.$emit('change', -0.25);
    readouts[1].vm.$emit('change', -6);
    await wrapper.vm.$nextTick();

    expect(store.tracks[0].mixer).toMatchObject({ pan: -0.25, gainDb: -6 });
  });

  it('reflects an external routing change in the selected value', async () => {
    const busId = addMixerBus({ name: 'FX' });
    const wrapper = mountStrip(trackId);
    setStripOutputBus(trackId, busId);
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(SelectMenu).props('modelValue')).toBe(busId);
  });
});
