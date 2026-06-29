import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import TransportBar from '@/components/shell/TransportBar.vue';

function makeRecording(overrides: Record<string, unknown> = {}) {
  return {
    armedTrackId: ref(1),
    countInBars: ref(0),
    inputLevel: ref(0),
    isCountingIn: ref(false),
    isRecording: ref(false),
    monitorEnabled: ref(false),
    setMonitor: vi.fn(),
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
  it('toggles input monitoring through the recording controller', async () => {
    const recording = makeRecording();
    const wrapper = mountBar({ recording });

    const monitor = menuButton(wrapper, 'Monitor input');
    expect(monitor.attributes('aria-pressed')).toBe('false');
    await monitor.trigger('click');

    expect(recording.setMonitor).toHaveBeenCalledWith(true);
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
