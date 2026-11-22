import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import TransportBar from '@/components/shell/TransportBar.vue';
import { fakeMidiRecording, fakeRecording } from './fakes/composables';
import { fakeEngineHandle } from './fakes/engine';

function recording() {
  return fakeRecording({ armedTrackId: ref(1) });
}

describe('TransportBar position readout', () => {
  it('updates the readout without re-rendering the whole bar', async () => {
    const bbt = ref('1.1.000');
    const seconds = ref(0);
    const triggered: string[] = [];
    const wrapper = mount(TransportBar, {
      props: {
        autoPunchEnabled: false,
        readBbtDisplay: () => bbt.value,
        bridge: null,
        canRecord: true,
        countInChoices: [{ value: 0 }, { value: 1 }],
        handle: fakeEngineHandle(),
        hasLocatorWindow: true,
        isCountingIn: false,
        isPlaying: true,
        isRecording: false,
        loopEnabled: false,
        metronomeEnabled: false,
        metronomeVolume: 0.35,
        readPositionSeconds: () => seconds.value,
        recording: recording(),
        recordingInputDeviceOptions: [{ value: '', label: 'Default input' }],
        midiRecording: fakeMidiRecording(),
        recordMenuOpen: false,
        storeInitialized: true,
        tempoInput: 120,
      },
      global: {
        stubs: { LevelMeter: { template: '<div />' }, TransportIcon: { template: '<span />' } },
        mixins: [
          {
            renderTriggered() {
              triggered.push(this.$options.__name ?? this.$options.name ?? 'anonymous');
            },
          },
        ],
      },
    });

    bbt.value = '2.3.480';
    seconds.value = 4.5;
    await nextTick();

    expect((wrapper.get('.position-bbt').element as HTMLInputElement).value).toBe('2.3.480');
    expect(wrapper.get('.position-seconds').text()).toBe('4.50s');
    expect(triggered).not.toContain('TransportBar');
    expect(triggered.length).toBeGreaterThan(0);
  });
});
