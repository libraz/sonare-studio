import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ClipInspector from '@/components/arrangement/ClipInspector.vue';
import Sf2ChannelMap from '@/components/devices/Sf2ChannelMap.vue';
import StripOptionsPopover from '@/components/mixer/StripOptionsPopover.vue';
import GeneralTab from '@/components/settings/GeneralTab.vue';
import TransportBar from '@/components/shell/TransportBar.vue';
import StepSequencer from '@/components/step-sequencer/StepSequencer.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import {
  clearHistory,
  setClipGain,
  setStripChannelDelaySamples,
  setStripWidth,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { readInputNumber, restoreInputValue } from '@/ui/numeric-input';
import { vTooltip } from '@/ui/tooltip';
import { fakeMidiRecording, fakeRecording } from './fakes/composables';
import { fakeEngineHandle } from './fakes/engine';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

vi.mock('@/project/commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/project/commands')>();
  return { ...actual, setClipGain: vi.fn(actual.setClipGain) };
});

const global = { directives: { tooltip: vTooltip } };

/** An event whose target is a fresh input holding `text`. */
function inputEvent(text: string): Event {
  const input = document.createElement('input');
  input.value = text;
  const event = new Event('change');
  Object.defineProperty(event, 'target', { value: input });
  return event;
}

describe('readInputNumber / restoreInputValue', () => {
  it('reads null for blank, whitespace and non-numeric text', () => {
    expect(readInputNumber(inputEvent(''))).toBeNull();
    expect(readInputNumber(inputEvent('   '))).toBeNull();
    expect(readInputNumber(inputEvent('abc'))).toBeNull();
  });

  it('reads finite numbers', () => {
    expect(readInputNumber(inputEvent('12'))).toBe(12);
    expect(readInputNumber(inputEvent('-3.5'))).toBe(-3.5);
  });

  it('writes the model value back as text', () => {
    const event = inputEvent('');
    restoreInputValue(event, 42);
    expect((event.target as HTMLInputElement).value).toBe('42');
  });
});

describe('blank number fields commit nothing', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(setClipGain).mockClear();
  });

  async function initStore() {
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    return store;
  }

  it('StripOptionsPopover keeps the width when a blank value is committed', async () => {
    const store = await initStore();
    const trackId = store.tracks[0].id;
    setStripWidth(trackId, 1.5);
    const wrapper = mount(StripOptionsPopover, {
      props: { target: trackId, name: 'Track 1' },
      global,
    });
    await wrapper.find('.strip-options-btn').trigger('click');

    // A range input is never blank in a browser; force the empty read.
    const width = wrapper.find<HTMLInputElement>('input[type="range"][aria-label="Width"]');
    Object.defineProperty(width.element, 'value', {
      configurable: true,
      get: () => '',
      set: () => undefined,
    });
    await width.trigger('input');
    await width.trigger('change');

    expect(store.tracks[0].mixer?.width).toBe(1.5);
    wrapper.unmount();
  });

  it('StripOptionsPopover keeps the channel delay and shows it again on change', async () => {
    const store = await initStore();
    const trackId = store.tracks[0].id;
    setStripChannelDelaySamples(trackId, 12);
    const wrapper = mount(StripOptionsPopover, {
      props: { target: trackId, name: 'Track 1' },
      global,
    });
    await wrapper.find('.strip-options-btn').trigger('click');

    const delay = wrapper.find<HTMLInputElement>('input[aria-label="Channel delay"]');
    expect(delay.element.value).toBe('12');
    delay.element.value = '';
    await delay.trigger('change');

    expect(store.tracks[0].mixer?.channelDelaySamples).toBe(12);
    expect(delay.element.value).toBe('12');
    wrapper.unmount();
  });

  it('ClipInspector keeps the gain and shows it again on change', async () => {
    const wrapper = mount(ClipInspector, {
      props: {
        clip: {
          id: 7,
          trackId: 1,
          name: 'Loop A',
          startPpq: 0,
          lengthPpq: 16,
          sourceOffsetPpq: 0,
          gain: 0.5,
          loopEnabled: false,
          loopLengthPpq: 0,
          notes: [],
          kind: 'audio',
          assetId: 'asset-1',
        },
      },
      global,
    });
    const gain = wrapper.find<HTMLInputElement>('input[aria-label="Clip gain in decibels"]');
    expect(Number(gain.element.value)).toBe(-6);
    gain.element.value = '';
    await gain.trigger('change');

    expect(setClipGain).not.toHaveBeenCalled();
    expect(Number(gain.element.value)).toBe(-6);
    wrapper.unmount();
  });

  it('StepSequencer keeps the seed and shows it again on change', async () => {
    await initStore();
    const wrapper = mount(StepSequencer, { global });
    await flushPromises();
    const vm = wrapper.vm as unknown as { pattern: { seed: number } };
    const seed = wrapper.find<HTMLInputElement>('input[aria-label="Random seed"]');

    await seed.setValue('5');
    expect(vm.pattern.seed).toBe(5);

    seed.element.value = '';
    await seed.trigger('change');
    expect(vm.pattern.seed).toBe(5);
    expect(seed.element.value).toBe('5');
    wrapper.unmount();
  });

  it('Sf2ChannelMap passes through the empty state on input and commits only the typed value', async () => {
    const wrapper = mount(Sf2ChannelMap, {
      props: { modelValue: [{ channel: 0, bank: 0, program: 3 }], defaultBank: 0 },
      global,
    });
    const program = wrapper.find<HTMLInputElement>('.sf2-channel-program');

    program.element.value = '';
    await program.trigger('input');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(program.element.value).toBe('');

    program.element.value = '7';
    await program.trigger('input');
    const emitted = wrapper.emitted('update:modelValue') ?? [];
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0]).toEqual([{ channel: 0, bank: 0, program: 7 }]);
    wrapper.unmount();
  });

  it('Sf2ChannelMap shows the previous program again when a blank field is committed', async () => {
    const wrapper = mount(Sf2ChannelMap, {
      props: { modelValue: [{ channel: 0, bank: 0, program: 3 }], defaultBank: 0 },
      global,
    });
    const program = wrapper.find<HTMLInputElement>('.sf2-channel-program');

    program.element.value = '';
    await program.trigger('input');
    await program.trigger('change');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(program.element.value).toBe('3');
    wrapper.unmount();
  });

  it('TransportBar cancels a blank tempo edit instead of applying it', async () => {
    const wrapper = mount(TransportBar, {
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
        recording: fakeRecording(),
        recordingInputDeviceOptions: [{ value: '', label: 'Default input' }],
        midiRecording: fakeMidiRecording(),
        recordMenuOpen: false,
        storeInitialized: true,
        tempoInput: 120,
      } as never,
      global: {
        ...global,
        stubs: { LevelMeter: { template: '<div />' }, TransportIcon: { template: '<span />' } },
      },
    });
    const tempo = wrapper.find<HTMLInputElement>('input[aria-label="Tempo in beats per minute"]');

    tempo.element.value = '';
    await tempo.trigger('input');
    await tempo.trigger('change');
    await flushPromises();
    expect(wrapper.emitted('updateTempoInput')).toBeUndefined();
    expect(wrapper.emitted('applyTempo')).toBeUndefined();
    expect(wrapper.emitted('cancelTempoInput')).toHaveLength(1);
    expect(tempo.element.value).toBe('120');

    tempo.element.value = '96';
    await tempo.trigger('input');
    await tempo.trigger('change');
    expect(wrapper.emitted('updateTempoInput')).toEqual([[96]]);
    expect(wrapper.emitted('applyTempo')).toHaveLength(1);
    wrapper.unmount();
  });

  it('GeneralTab keeps the loudness target and shows it again on change', async () => {
    const settings = useAppSettings();
    const before = settings.settings.loudnessTargetLufs;
    const wrapper = mount(GeneralTab, { global });
    const inputs = wrapper.findAll<HTMLInputElement>('input[type="number"]');
    const loudness = inputs[inputs.length - 1];
    expect(Number(loudness.element.value)).toBe(before);

    loudness.element.value = '';
    await loudness.trigger('change');

    expect(settings.settings.loudnessTargetLufs).toBe(before);
    expect(Number(loudness.element.value)).toBe(before);
    wrapper.unmount();
  });
});
