import { mount, shallowMount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BusStrip from '@/components/mixer/BusStrip.vue';
import ChannelStrip from '@/components/mixer/ChannelStrip.vue';
import InsertRack from '@/components/mixer/InsertRack.vue';
import MixerPanel from '@/components/mixer/MixerPanel.vue';
import StripOptionsPopover from '@/components/mixer/StripOptionsPopover.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import {
  addGroupTrack,
  addInsert,
  addMixerBus,
  addTrack,
  clearHistory,
  mixerBusStripTarget,
  setStripOutputBus,
  setStripPan,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { selectMenuProps } from './helpers/select-menu';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('MixerPanel.vue', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('applies a built-in mixer template from the toolbar menu', async () => {
    addTrack({ name: 'Guest' });
    addTrack({ name: 'Music' });
    const wrapper = shallowMount(MixerPanel, {
      global: {
        directives: { tooltip: {} },
        stubs: {
          ChannelStrip: true,
          BusStrip: true,
          VcaStrip: true,
          MixerSnapshots: true,
          TransitionGroup: false,
        },
      },
    });

    const templateButton = wrapper
      .findAll('.toolbar-button')
      .find((button) => button.text().includes('Templates'));
    expect(templateButton).toBeTruthy();
    await templateButton!.trigger('click');

    const items = wrapper.findAll('.scene-menu .view-menu-action');
    expect(items.map((item) => item.text())).toContain('Commentary Ducking');
    const commentary = items.find((item) => item.text() === 'Commentary Ducking');
    expect(commentary).toBeTruthy();
    await commentary!.trigger('click');

    expect(store.mixer.vcaGroups).toEqual([{ id: 'voices', name: 'Voices', gainDb: 0 }]);
    expect(store.tracks[2].mixer?.inserts[0]).toMatchObject({
      processor: 'dynamics.sidechainRouter',
      sidechainSourceTrackId: store.tracks[0].id,
    });
    expect(wrapper.find('.scene-menu').exists()).toBe(false);
  });

  it('removes toolbar menu outside-click listeners on unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const wrapper = shallowMount(MixerPanel, {
      global: {
        directives: { tooltip: {} },
        stubs: {
          ChannelStrip: true,
          BusStrip: true,
          VcaStrip: true,
          MixerSnapshots: true,
          TransitionGroup: false,
        },
      },
    });

    const templateButton = wrapper
      .findAll('.toolbar-button')
      .find((button) => button.text().includes('Templates'));
    await templateButton!.trigger('click');

    expect(add).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    wrapper.unmount();
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
  });

  it('changes the mixer solo audition mode from the toolbar', async () => {
    const wrapper = shallowMount(MixerPanel, {
      global: {
        directives: { tooltip: {} },
        stubs: {
          ChannelStrip: true,
          BusStrip: true,
          VcaStrip: true,
          MixerSnapshots: true,
          TransitionGroup: false,
        },
      },
    });

    const soloMode = wrapper.findComponent({ name: 'SelectMenu' });
    expect(soloMode.exists()).toBe(true);
    await soloMode.vm.$emit('update:modelValue', 'pfl');

    expect(store.mixer.soloMode).toBe('pfl');
  });

  it('keeps group strips on the bus-capable pan/EQ surface', () => {
    const groupId = addGroupTrack({ name: 'Music Bus' });
    const wrapper = shallowMount(ChannelStrip, { props: { target: groupId } });

    expect(wrapper.find('.strip-pan').exists()).toBe(true);
    expect(wrapper.findComponent({ name: 'StripEqSection' }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: 'StripOptionsPopover' }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: 'StripAutomationControls' }).exists()).toBe(false);
    expect(wrapper.findComponent({ name: 'StripSends' }).exists()).toBe(true);
    expect(wrapper.find('.strip-output').exists()).toBe(false);
  });

  it('exposes return-bus sends, output routing and channel layout controls', async () => {
    addMixerBus({ name: 'Parallel' });
    const destinationBusId = addMixerBus({ name: 'Master FX' });
    const wrapper = shallowMount(BusStrip, {
      props: { bus: store.mixer.buses[0] },
      global: {
        directives: { tooltip: {} },
        stubs: {
          InsertRack: true,
          StripEqSection: true,
          StripSends: true,
          StripMeter: true,
          MixerFader: true,
          MixerKnob: true,
          NumericReadout: true,
          StripGrMeter: true,
          SpectrumAnalyzer: true,
          StereoGoniometer: true,
          StripOptionsPopover: true,
        },
      },
    });

    expect(wrapper.find('.bus-routing').exists()).toBe(true);
    expect(wrapper.findComponent({ name: 'StripSends' }).exists()).toBe(true);
    const selects = wrapper.findAllComponents(SelectMenu);
    expect(selects).toHaveLength(2);

    await selects[0].vm.$emit('change', destinationBusId);
    await selects[1].vm.$emit('change', '5.1');
    await wrapper.vm.$nextTick();

    expect(store.mixer.buses[0]).toMatchObject({ channelLayout: '5.1' });
    expect(store.mixer.buses[0].strip).toMatchObject({ outputBusId: destinationBusId });
  });

  it('disables stereo bus pan and width controls for surround layouts', async () => {
    const busId = addMixerBus({ name: 'Surround', channelLayout: '5.1' });
    const busWrapper = shallowMount(BusStrip, {
      props: { bus: store.mixer.buses[0] },
      global: {
        directives: { tooltip: {} },
        stubs: {
          InsertRack: true,
          StripEqSection: true,
          StripSends: true,
          StripMeter: true,
          MixerFader: true,
          MixerKnob: true,
          NumericReadout: true,
          StripGrMeter: true,
          SpectrumAnalyzer: true,
          StereoGoniometer: true,
          StripOptionsPopover: true,
        },
      },
    });

    expect(busWrapper.find('.bus-pan').classes()).toContain('disabled');
    const stereoOnly = 'Stereo pan and width are unavailable on surround buses';
    expect(busWrapper.findComponent({ name: 'MixerKnob' }).props('reason')).toBe(stereoOnly);
    expect(busWrapper.findAllComponents({ name: 'NumericReadout' })[0]?.props('reason')).toBe(
      stereoOnly,
    );
    expect(busWrapper.find('.bus-pan-note').text()).toBe('Stereo only');

    const optionsWrapper = mount(StripOptionsPopover, {
      props: { target: mixerBusStripTarget(busId), name: 'Surround' },
      global: { directives: { tooltip: {} } },
    });
    await optionsWrapper.find('.strip-options-btn').trigger('click');

    expect(optionsWrapper.find('.strip-options-note').text()).toContain('Stereo pan and width');
    const ranges = optionsWrapper.findAll('input[type="range"]');
    expect(ranges[1]?.attributes('disabled')).toBeDefined();
    const pannerSelects = optionsWrapper.findAllComponents(SelectMenu);
    expect(pannerSelects).toHaveLength(2);
    expect(pannerSelects.every((select) => selectMenuProps(select).reason === stereoOnly)).toBe(
      true,
    );
    optionsWrapper.unmount();
  });

  it('filters sidechain keys by strip capability and disables group feedback choices', async () => {
    const targetId = store.tracks[0].id;
    const groupId = addGroupTrack({ name: 'Drum Bus' });
    addMixerBus({ name: 'Verb' });
    addInsert(targetId, 'dynamics.sidechainRouter');

    const ordinaryWrapper = mount(InsertRack, {
      props: { target: targetId },
      global: {
        directives: { tooltip: {} },
        stubs: { MixerKnob: true, Teleport: true },
      },
    });
    await ordinaryWrapper.find('.insert-name').trigger('click');
    await ordinaryWrapper.find('.insert-sidechain-select .select-trigger').trigger('click');
    const ordinaryOptions = ordinaryWrapper.findAll('.select-option');
    expect(ordinaryOptions.map((option) => option.text())).not.toContain('Verb · BUS');
    expect(ordinaryOptions.map((option) => option.text())).not.toContain('Drum Bus · GROUP');
    ordinaryWrapper.unmount();

    const groupOutput = addMixerBus({ name: 'Group out' });
    const feedbackSource = addMixerBus({ name: 'Feedback source' });
    setStripOutputBus(groupId, groupOutput);
    setStripOutputBus(mixerBusStripTarget(groupOutput), feedbackSource);
    addInsert(groupId, 'dynamics.sidechainRouter');

    const groupWrapper = mount(InsertRack, {
      props: { target: groupId },
      global: {
        directives: { tooltip: {} },
        stubs: { MixerKnob: true, Teleport: true },
      },
    });
    await groupWrapper.find('.insert-name').trigger('click');
    await groupWrapper.find('.insert-sidechain-select .select-trigger').trigger('click');
    const feedbackOption = groupWrapper
      .findAll('.select-option')
      .find((option) => option.text() === 'Feedback source · BUS');
    expect(feedbackOption?.classes()).toContain('is-disabled');
    groupWrapper.unmount();
  });

  it('blocks surround layout choices until stereo bus shaping is neutral', async () => {
    const busId = addMixerBus({ name: 'Shaped bus' });
    setStripPan(mixerBusStripTarget(busId), 0.25);
    const wrapper = shallowMount(BusStrip, {
      props: { bus: store.mixer.buses[0] },
      global: {
        directives: { tooltip: {} },
        stubs: {
          InsertRack: true,
          StripEqSection: true,
          StripSends: true,
          StripMeter: true,
          MixerFader: true,
          MixerKnob: true,
          NumericReadout: true,
          StripGrMeter: true,
          SpectrumAnalyzer: true,
          StereoGoniometer: true,
          StripOptionsPopover: true,
        },
      },
    });

    const layoutSelect = wrapper.findAllComponents(SelectMenu)[1];
    const surroundOption = selectMenuProps(layoutSelect).options.find(
      (option) => option.value === '5.1',
    );
    expect(surroundOption?.disabled).toBe(true);

    await layoutSelect.vm.$emit('change', '5.1');
    expect(store.mixer.buses[0].channelLayout).toBeUndefined();
    expect(wrapper.find('.bus-route-error').text()).toContain('Reset stereo pan');
  });
});
