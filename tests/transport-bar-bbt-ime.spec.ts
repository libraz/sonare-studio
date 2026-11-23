import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TransportBar from '@/components/shell/TransportBar.vue';
import { fakeMidiRecording, fakeRecording } from './fakes/composables';
import { fakeEngineHandle } from './fakes/engine';
import { enterKey } from './ime-test-helpers';

function mountBar(): VueWrapper {
  return mount(TransportBar, {
    attachTo: document.body,
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
      stubs: { LevelMeter: { template: '<div />' }, TransportIcon: { template: '<span />' } },
    },
  });
}

describe('TransportBar position field Enter', () => {
  it('keeps the field focused while an IME composition confirms', () => {
    const wrapper = mountBar();
    const input = wrapper.find('.position-bbt').element as HTMLInputElement;
    input.focus();
    input.dispatchEvent(enterKey(true));
    expect(document.activeElement).toBe(input);
    expect(wrapper.emitted('bbtBlur')).toBeUndefined();
    wrapper.unmount();
  });

  it('commits by blurring on a plain Enter', () => {
    const wrapper = mountBar();
    const input = wrapper.find('.position-bbt').element as HTMLInputElement;
    input.focus();
    input.dispatchEvent(enterKey(false));
    expect(document.activeElement).not.toBe(input);
    expect(wrapper.emitted('bbtBlur')).toHaveLength(1);
    wrapper.unmount();
  });
});
