import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import TransportBar from '@/components/shell/TransportBar.vue';
import type { UseRecordingReturn } from '@/composables/useRecording';
import { fakeMidiRecording, fakeRecording } from './fakes/composables';
import { fakeEngineHandle } from './fakes/engine';

const wasm = vi.hoisted(() => ({
  load: async (): Promise<unknown> => ({}),
}));
vi.mock('@/lib/wasm', () => ({ ensureWasm: () => wasm.load() }));

function mountBar(recording: UseRecordingReturn): VueWrapper {
  return mount(TransportBar, {
    props: {
      autoPunchEnabled: false,
      readBbtDisplay: () => '1.1.000',
      bridge: null,
      canRecord: true,
      countInChoices: [{ value: 0 }],
      handle: fakeEngineHandle(),
      hasLocatorWindow: true,
      isCountingIn: false,
      isPlaying: false,
      isRecording: false,
      loopEnabled: false,
      metronomeEnabled: false,
      metronomeVolume: 0.35,
      readPositionSeconds: () => 0,
      recording,
      recordingInputDeviceOptions: [{ value: '', label: 'Default input' }],
      midiRecording: fakeMidiRecording(),
      recordMenuOpen: true,
      storeInitialized: true,
      tempoInput: 120,
    } as never,
    global: {
      stubs: { LevelMeter: { template: '<div />' }, TransportIcon: { template: '<span />' } },
    },
  });
}

async function applyCustomVoice(wrapper: VueWrapper): Promise<void> {
  wrapper.findAllComponents(SelectMenu)[5].vm.$emit('change', 'custom-json');
  await wrapper.vm.$nextTick();
  const apply = wrapper
    .findAll('.record-pop button')
    .find((node) => node.text() === 'Apply voice JSON');
  if (!apply) throw new Error('missing apply button');
  await apply.trigger('click');
  await flushPromises();
}

describe('TransportBar custom voice preset errors', () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);

  beforeEach(() => {
    rejections.length = 0;
    process.on('unhandledRejection', onRejection);
  });
  afterEach(() => {
    process.off('unhandledRejection', onRejection);
  });

  it('shows an error when the wasm module fails to load', async () => {
    wasm.load = async () => {
      throw new Error('wasm unavailable');
    };
    const recording = fakeRecording({ armedTrackId: ref<number | null>(1) });
    const wrapper = mountBar(recording);
    await applyCustomVoice(wrapper);
    expect(rejections).toEqual([]);
    expect(wrapper.find('.voice-json-error').exists()).toBe(true);
    expect(recording.setVoiceChangerPreset).not.toHaveBeenCalled();
  });

  it('shows an error when the validated document is not parseable', async () => {
    wasm.load = async () => ({
      realtimeVoiceChangerValidatePresetJson: () => ({ ok: true, normalizedJson: '{' }),
    });
    const recording = fakeRecording({ armedTrackId: ref<number | null>(1) });
    const wrapper = mountBar(recording);
    await applyCustomVoice(wrapper);
    expect(rejections).toEqual([]);
    expect(wrapper.find('.voice-json-error').exists()).toBe(true);
    expect(recording.setVoiceChangerPreset).not.toHaveBeenCalled();
  });
});
