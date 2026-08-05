import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BusStrip from '@/components/mixer/BusStrip.vue';
import MixerFader from '@/components/mixer/MixerFader.vue';
import NumericReadout from '@/components/mixer/NumericReadout.vue';
import { MIDI_LEARN_KEY, useMidiLearn } from '@/composables/useMidiLearn';
import type { MeterSource, StereoMeterLevels } from '@/engine/meters';
import { busAutomationTarget } from '@/project/automation';
import { addMixerBus, clearHistory, setAutomationLanePoints } from '@/project/commands';
import { MAX_MIXER_BUSES } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { midiLearnBusStripControlTargetId } from '@/ui/midi/midi-learn';
import { resetAutomationStripModes } from '@/ui/mixer/automation-mode';

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

describe('BusStrip automation UI', () => {
  let store: ReturnType<typeof useProjectStore>;
  let busId: string;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    resetAutomationStripModes();
    clearHistory();
    await store.init();
    busId = addMixerBus({ name: 'FX' });
  });

  function mountStrip(
    positionPpq = 0,
    bridge: MeterSource | null = null,
    scheduleAutomationWrite?: (...args: unknown[]) => void,
  ) {
    return mount(BusStrip, {
      props: {
        bus: store.mixer.buses[0],
        bridge,
        positionPpq: () => positionPpq,
        positionSample: () => 384000,
        isPlaying: scheduleAutomationWrite !== undefined,
        scheduleAutomationWrite,
      },
      global: {
        stubs: {
          InsertRack: true,
          StripMeter: true,
        },
      },
    });
  }

  it('shows the bus automation lane value in read mode', async () => {
    setAutomationLanePoints(busAutomationTarget(busId), 'faderDb', [
      { ppq: 0, value: -12 },
      { ppq: 960, value: -6 },
    ]);
    const wrapper = mountStrip(480);

    await wrapper
      .findAll('.bus-auto-button')
      .find((button) => button.text() === 'R')
      ?.trigger('click');

    expect(wrapper.getComponent(MixerFader).props('valueDb')).toBe(-9);
  });

  it('mutes the return without changing its fader value', async () => {
    const wrapper = mountStrip();
    await wrapper.get('.bus-toggle.mute').trigger('click');

    expect(store.mixer.buses[0]).toMatchObject({ gainDb: 0, mute: true });
    await wrapper.setProps({ bus: store.mixer.buses[0] });
    expect(wrapper.get('.bus-toggle.mute').attributes('aria-pressed')).toBe('true');
  });

  it('solos the return from its own strip', async () => {
    const wrapper = mountStrip();
    await wrapper.get('.bus-toggle.solo').trigger('click');

    expect(store.mixer.buses[0]).toMatchObject({ solo: true });
    await wrapper.setProps({ bus: store.mixer.buses[0] });
    expect(wrapper.get('.bus-toggle.solo').attributes('aria-pressed')).toBe('true');
  });

  it('disables return solo when no engine bus slot is free', async () => {
    for (let index = store.mixer.buses.length; index < MAX_MIXER_BUSES; index += 1) {
      addMixerBus();
    }
    const wrapper = mountStrip();

    expect(wrapper.get('.bus-toggle.solo').attributes('disabled')).toBeDefined();
  });

  it('shows bus gain reduction when the bus meter reports dynamics GR', async () => {
    const wrapper = mountStrip(0, meterSource({ gainReductionDb: -5.5 }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.strip-gr-value').text()).toBe('-5.5');
  });

  it('writes bus output trim, width, and polarity from the shaping popover', async () => {
    const wrapper = mountStrip();
    await wrapper.find('.strip-options-btn').trigger('click');
    const ranges = wrapper.findAll('.strip-options-popover input[type="range"]');
    expect(ranges).toHaveLength(2);

    await ranges[0].setValue('-6');
    await ranges[0].trigger('change');
    expect(store.mixer.buses[0].strip?.inputTrimDb).toBe(-6);

    await ranges[1].setValue('1.5');
    await ranges[1].trigger('change');
    expect(store.mixer.buses[0].strip?.width).toBe(1.5);

    await wrapper.findAll('.strip-options-toggles .toggle')[0].trigger('click');
    expect(store.mixer.buses[0].strip?.polarityInvertLeft).toBe(true);
  });

  it('commits exact bus gain, input trim, and width values from numeric readouts', async () => {
    const wrapper = mountStrip();
    wrapper.getComponent(NumericReadout).vm.$emit('change', -6);
    await wrapper.vm.$nextTick();
    expect(store.mixer.buses[0].gainDb).toBe(-6);

    await wrapper.find('.strip-options-btn').trigger('click');
    const readouts = wrapper.findAllComponents(NumericReadout);
    readouts.find((readout) => readout.props('min') === -48)?.vm.$emit('change', -3.5);
    readouts.find((readout) => readout.props('min') === 0)?.vm.$emit('change', 1.25);
    await wrapper.vm.$nextTick();
    expect(store.mixer.buses[0].strip).toMatchObject({ inputTrimDb: -3.5, width: 1.25 });
  });

  it('learns and applies bus strip controls through the shared popover', async () => {
    const learn = useMidiLearn();
    const wrapper = mount(BusStrip, {
      props: { bus: store.mixer.buses[0] },
      global: {
        provide: { [MIDI_LEARN_KEY as symbol]: learn },
        stubs: { InsertRack: true, StripMeter: true },
      },
    });
    const targetId = midiLearnBusStripControlTargetId(busId, 'inputTrimDb');

    await wrapper.find('.strip-options-btn').trigger('click');
    await wrapper.find('.strip-midi-learn').trigger('click');
    expect(learn.isArmedId(targetId)).toBe(true);

    learn.handleCc({ channel: 0, controller: 31, value: 127 });
    await wrapper.vm.$nextTick();
    expect(learn.bindingForId(targetId)).toEqual({ channel: 0, controller: 31 });
    expect(store.mixer.buses[0].strip?.inputTrimDb).toBe(48);
  });

  it('removes the options popover outside-click listener on unmount', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const wrapper = mountStrip();

    await wrapper.find('.strip-options-btn').trigger('click');

    expect(add).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    wrapper.unmount();
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
  });

  it('writes touch automation from the bus fader', async () => {
    const scheduled: unknown[] = [];
    const wrapper = mountStrip(960, null, (...args) => scheduled.push(args));
    await wrapper
      .findAll('.bus-auto-button')
      .find((button) => button.text() === 'T')
      ?.trigger('click');

    wrapper.getComponent(MixerFader).vm.$emit('change', -9, false);
    await wrapper.vm.$nextTick();

    expect(wrapper.getComponent(MixerFader).props('valueDb')).toBe(-9);
    expect(wrapper.find('.bus-readout').text()).toBe('-9.0 dB');

    wrapper.getComponent(MixerFader).vm.$emit('change', -9, true);

    expect(store.mixer.buses[0].gainDb).toBe(0);
    expect(store.automationLanes).toEqual([
      {
        target: busAutomationTarget(busId),
        param: 'faderDb',
        enabled: true,
        points: [{ ppq: 960, value: -9 }],
      },
    ]);
    expect(scheduled).toEqual([
      [busAutomationTarget(busId), 'faderDb', { ppq: 960, samplePos: 384000, value: -9 }],
      [busAutomationTarget(busId), 'faderDb', { ppq: 960, samplePos: 384000, value: -9 }],
    ]);
  });

  it('commits an active automation write when the bus strip unmounts', async () => {
    const wrapper = mountStrip(960);
    await wrapper
      .findAll('.bus-auto-button')
      .find((button) => button.text() === 'T')
      ?.trigger('click');

    wrapper.getComponent(MixerFader).vm.$emit('change', -9, false);
    wrapper.unmount();

    expect(store.automationLanes).toEqual([
      {
        target: busAutomationTarget(busId),
        param: 'faderDb',
        enabled: true,
        points: [{ ppq: 960, value: -9 }],
      },
    ]);
  });
});
