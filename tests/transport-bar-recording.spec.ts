import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import TransportBar from '@/components/shell/TransportBar.vue';

function makeRecording(overrides: Record<string, unknown> = {}) {
  return {
    armedTrackId: ref(1),
    countInBars: ref(0),
    inputLevel: ref(0),
    isCountingIn: ref(false),
    isRecording: ref(false),
    monitorEnabled: ref(false),
    captureSource: ref('input'),
    inputDeviceId: ref(''),
    voiceChangerPreset: ref('off'),
    streamingRetuneSemitones: ref(0),
    setMonitor: vi.fn(),
    setCaptureSource: vi.fn(),
    setVoiceChangerPreset: vi.fn(),
    setStreamingRetuneSemitones: vi.fn(),
    ...overrides,
  };
}

function makeMidiRecording(overrides: Record<string, unknown> = {}) {
  return {
    isRecording: ref(false),
    inputQuantizeDenominator: ref(0),
    ...overrides,
  };
}

function mountBar(props: Record<string, unknown> = {}): VueWrapper {
  return mount(TransportBar, {
    props: {
      autoPunchEnabled: false,
      bbtDisplay: '1.1.000',
      bridge: null,
      countInChoices: [
        { value: 0, label: 'Off' },
        { value: 1, label: '1 bar' },
      ],
      handle: {},
      hasLocatorWindow: true,
      isPlaying: false,
      loopEnabled: false,
      metronomeEnabled: false,
      positionSeconds: 0,
      recording: makeRecording(),
      recordingInputDeviceOptions: [
        { value: '', label: 'Default input' },
        { value: 'usb-mic', label: 'USB Mic' },
      ],
      midiRecording: makeMidiRecording(),
      recordMenuOpen: true,
      shortcutTitle: (base: string) => base,
      storeInitialized: true,
      tempoInput: 120,
      ...props,
    },
    global: {
      stubs: {
        LevelMeter: { template: '<div />' },
        TransportIcon: { template: '<span />' },
      },
    },
  });
}

function menuButton(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll('.record-pop button').find((node) => node.text() === label);
  if (!button) throw new Error(`missing record menu button: ${label}`);
  return button;
}

describe('TransportBar recording settings', () => {
  it('updates the recording capture source from the recording settings', async () => {
    const recording = makeRecording();
    const wrapper = mountBar({ recording });

    const selects = wrapper.findAllComponents(SelectMenu);
    selects[0].vm.$emit('change', 'output');

    expect(wrapper.emitted('recordSourceChange')).toEqual([['output']]);
  });

  it('updates the selected input device from the recording settings', async () => {
    const wrapper = mountBar();

    const selects = wrapper.findAllComponents(SelectMenu);
    selects[1].vm.$emit('change', 'usb-mic');

    expect(wrapper.emitted('recordInputDeviceChange')).toEqual([['usb-mic']]);
  });

  it('updates MIDI input quantize from the recording settings', async () => {
    const wrapper = mountBar();

    const selects = wrapper.findAllComponents(SelectMenu);
    selects[3].vm.$emit('change', 16);

    expect(wrapper.emitted('midiInputQuantizeChange')).toEqual([[16]]);
  });

  it('toggles input monitoring through the recording controller', async () => {
    const recording = makeRecording();
    const wrapper = mountBar({ recording });

    const monitor = menuButton(wrapper, 'Monitor input');
    expect(monitor.attributes('aria-pressed')).toBe('false');
    await monitor.trigger('click');

    expect(recording.setMonitor).toHaveBeenCalledWith(true);
  });

  it('updates the realtime voice changer preset from the recording settings', async () => {
    const recording = makeRecording();
    const wrapper = mountBar({ recording });

    const selects = wrapper.findAllComponents(SelectMenu);
    selects[4].vm.$emit('change', 'bright-idol');

    expect(recording.setVoiceChangerPreset).toHaveBeenCalledWith('bright-idol');
  });

  it('applies a custom realtime voice changer JSON preset', async () => {
    const recording = makeRecording();
    const wrapper = mountBar({ recording });

    const selects = wrapper.findAllComponents(SelectMenu);
    selects[4].vm.$emit('change', 'custom-json');
    await wrapper.vm.$nextTick();

    await wrapper.get('textarea[aria-label="Voice preset JSON"]').setValue(
      JSON.stringify({
        schemaVersion: 1,
        name: 'Telephone',
        macros: { wet: 0.8 },
        dsp: { formantFactor: 1.2 },
      }),
    );
    await menuButton(wrapper, 'Apply voice JSON').trigger('click');

    expect(recording.setVoiceChangerPreset).toHaveBeenCalledWith({
      schemaVersion: 1,
      name: 'Telephone',
      macros: { wet: 0.8 },
      dsp: { formantFactor: 1.2 },
    });
  });

  it('updates StreamingRetune semitones from the recording settings', async () => {
    const recording = makeRecording();
    const wrapper = mountBar({ recording });
    const input = wrapper.find('input[aria-label="Retune st"]');
    await input.setValue('7');
    await input.trigger('change');
    expect(recording.setStreamingRetuneSemitones).toHaveBeenCalledWith(7);
  });

  it('emits auto-punch toggles only when a locator window exists', async () => {
    const wrapper = mountBar({ autoPunchEnabled: false, hasLocatorWindow: true });

    const autoPunch = menuButton(wrapper, 'Auto-punch (locators)');
    expect(autoPunch.attributes('aria-pressed')).toBe('false');
    expect(autoPunch.attributes('disabled')).toBeUndefined();
    await autoPunch.trigger('click');
    expect(wrapper.emitted('toggleAutoPunch')).toHaveLength(1);

    const blocked = mountBar({ autoPunchEnabled: false, hasLocatorWindow: false });
    const blockedButton = menuButton(blocked, 'Auto-punch (locators)');
    expect(blockedButton.attributes('disabled')).toBeDefined();
    await blockedButton.trigger('click');
    expect(blocked.emitted('toggleAutoPunch')).toBeUndefined();
  });

  it('shows the punch indicator as a second toggle-off affordance while armed', async () => {
    const wrapper = mountBar({ autoPunchEnabled: true, hasLocatorWindow: true });

    const indicator = wrapper.get('.punch-indicator');
    expect(indicator.attributes('aria-label')).toBe('Auto-punch armed');
    await indicator.trigger('click');

    expect(wrapper.emitted('toggleAutoPunch')).toHaveLength(1);
  });
});
