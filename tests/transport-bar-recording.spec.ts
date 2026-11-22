import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import TransportBar from '@/components/shell/TransportBar.vue';
import type { UseMidiRecordingReturn } from '@/composables/useMidiRecording';
import type { UseRecordingReturn } from '@/composables/useRecording';
import { CUSTOM_VOICE_PRESET_TEMPLATE } from '@/ui/shell/custom-voice-preset';
import { coreWasmBinary } from './core-package';
import { fakeMidiRecording, fakeRecording } from './fakes/composables';
import { fakeEngineHandle } from './fakes/engine';

vi.mock('@/lib/wasm', async () => {
  const core = await import('@libraz/libsonare');
  return { ensureWasm: async () => core };
});

beforeAll(async () => {
  const core = await import('@libraz/libsonare');
  await core.init({ wasmBinary: coreWasmBinary() });
});

function makeRecording(overrides: Partial<UseRecordingReturn> = {}): UseRecordingReturn {
  return fakeRecording({ armedTrackId: ref<number | null>(1), ...overrides });
}

function makeMidiRecording(
  overrides: Partial<UseMidiRecordingReturn> = {},
): UseMidiRecordingReturn {
  return fakeMidiRecording(overrides);
}

function mountBar(props: Record<string, unknown> = {}): VueWrapper {
  return mount(TransportBar, {
    props: {
      autoPunchEnabled: false,
      readBbtDisplay: () => '1.1.000',
      bridge: null,
      canRecord: true,
      countInChoices: [{ value: 0 }, { value: 1 }],
      handle: fakeEngineHandle(),
      hasLocatorWindow: true,
      isCountingIn: false,
      isPlaying: false,
      isRecording: false,
      loopEnabled: false,
      metronomeEnabled: false,
      metronomeVolume: 0.35,
      readPositionSeconds: () => 0,
      recording: makeRecording(),
      recordingInputDeviceOptions: [
        { value: '', label: 'Default input' },
        { value: 'usb-mic', label: 'USB Mic' },
      ],
      midiRecording: makeMidiRecording(),
      recordMenuOpen: true,
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
  it('keeps the record control available and active for a MIDI-only session', async () => {
    const wrapper = mountBar({
      canRecord: true,
      isCountingIn: true,
      isRecording: true,
      recording: makeRecording({ armedTrackId: ref(null), isRecording: ref(false) }),
      midiRecording: makeMidiRecording({ isRecording: ref(true) }),
    });

    const record = wrapper.get('.record-button');
    expect(record.attributes('disabled')).toBeUndefined();
    expect(record.attributes('aria-pressed')).toBe('true');
    expect(record.classes()).toContain('recording');
    expect(record.classes()).toContain('counting-in');
    await record.trigger('click');
    expect(wrapper.emitted('toggleRecord')).toEqual([[]]);
  });

  it('emits metronome-volume changes from the transport control', async () => {
    const wrapper = mountBar({ metronomeEnabled: true });
    await wrapper.find('.metronome-volume-input').setValue('0.6');

    expect(wrapper.emitted('metronomeVolumeChange')).toEqual([[0.6]]);
  });

  it('disables the metronome volume while the click is off', () => {
    const wrapper = mountBar({ metronomeEnabled: false });
    expect(wrapper.get('.metronome-volume-input').attributes('disabled')).toBeDefined();
  });

  it('disables record until the engine boots but keeps held transport state editable', () => {
    const wrapper = mountBar({ handle: null });
    expect(wrapper.get('.record-button').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.transport-key.cycle').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('.click-toggle').attributes('disabled')).toBeUndefined();
    for (const nav of wrapper.findAll('.transport-nav')) {
      expect(nav.attributes('disabled')).toBeUndefined();
    }
    expect(wrapper.get('.transport-key.play').attributes('disabled')).toBeUndefined();
  });

  it('disables record without an armed track', () => {
    const wrapper = mountBar({ canRecord: false });
    expect(wrapper.get('.record-button').attributes('disabled')).toBeDefined();
  });

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

  it('updates MIDI cycle-record mode from the recording settings', () => {
    const midiRecording = makeMidiRecording();
    const wrapper = mountBar({ midiRecording });

    wrapper.findAllComponents(SelectMenu)[4].vm.$emit('change', 'overdub');

    expect(midiRecording.cycleRecordMode.value).toBe('overdub');
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
    selects[5].vm.$emit('change', 'brightIdol');

    expect(recording.setVoiceChangerPreset).toHaveBeenCalledWith('brightIdol');
  });

  it('applies a custom realtime voice changer JSON preset', async () => {
    const recording = makeRecording();
    const wrapper = mountBar({ recording });

    const selects = wrapper.findAllComponents(SelectMenu);
    selects[5].vm.$emit('change', 'custom-json');
    await wrapper.vm.$nextTick();

    await wrapper.get('textarea[aria-label="Voice preset JSON"]').setValue(
      JSON.stringify({
        schemaVersion: 4,
        id: 'telephone',
        name: 'Telephone',
        category: 'custom',
        macros: { pitch: 2 },
      }),
    );
    await menuButton(wrapper, 'Apply voice JSON').trigger('click');
    await flushPromises();

    expect(recording.setVoiceChangerPreset).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 4,
        id: 'telephone',
        dsp: expect.objectContaining({ retune: expect.objectContaining({ pitchSemitones: 2 }) }),
      }),
    );
  });

  it('refuses a voice JSON preset the core rejects, and the template it offers applies', async () => {
    const recording = makeRecording();
    const wrapper = mountBar({ recording });
    wrapper.findAllComponents(SelectMenu)[5].vm.$emit('change', 'custom-json');
    await wrapper.vm.$nextTick();
    const textarea = wrapper.get('textarea[aria-label="Voice preset JSON"]');

    await textarea.setValue(JSON.stringify({ schemaVersion: 1, macros: {}, dsp: {} }));
    await menuButton(wrapper, 'Apply voice JSON').trigger('click');
    await flushPromises();
    expect(recording.setVoiceChangerPreset).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('schemaVersion: 4');

    await textarea.setValue(CUSTOM_VOICE_PRESET_TEMPLATE);
    await menuButton(wrapper, 'Apply voice JSON').trigger('click');
    await flushPromises();
    expect(recording.setVoiceChangerPreset).toHaveBeenCalledTimes(1);
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
