import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import DiagnosticsPanel from '@/components/shell/DiagnosticsPanel.vue';

/**
 * The Diagnostics dialog is opened from the Help menu. With no engine handle it
 * must still present a clear "stopped" status (rather than an empty body) and
 * keep the engine-only actions disabled; once a handle exists it reports the
 * audio-output and runtime facts.
 */

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.textContent = '';
});

/** Minimal EngineHandle-shaped stub exposing only the fields the panel reads. */
function fakeHandle() {
  return {
    ctx: {
      sampleRate: 48000,
      baseLatency: 0.0053,
      outputLatency: 0,
      destination: { maxChannelCount: 2 },
    },
    capabilities: {
      mode: 'sab',
      runtimeTarget: 'sonare-rt',
      sharedArrayBuffer: true,
      atomics: true,
      abiCompatible: true,
    },
  } as never;
}

describe('DiagnosticsPanel', () => {
  it('renders nothing while closed', () => {
    wrapper = mount(DiagnosticsPanel, {
      props: { open: false, busy: false, ctxState: '', handle: null, renderInfo: '' },
      attachTo: document.body,
    });
    expect(document.body.querySelector('.diag')).toBeNull();
  });

  it('shows a stopped status and disables engine actions with no handle', () => {
    wrapper = mount(DiagnosticsPanel, {
      props: { open: true, busy: false, ctxState: '', handle: null, renderInfo: '' },
      attachTo: document.body,
    });

    expect(document.body.querySelector('.diag-status-off')).not.toBeNull();
    expect(document.body.querySelector('.diag-status-on')).toBeNull();
    // No engine → no fact tables, only the status + actions sections remain.
    expect(document.body.querySelector('.diag-facts')).toBeNull();
    for (const button of document.body.querySelectorAll('.diag-actions button')) {
      expect(button.hasAttribute('disabled')).toBe(true);
    }
  });

  it('reports output and runtime facts once the engine is running', () => {
    wrapper = mount(DiagnosticsPanel, {
      props: {
        open: true,
        busy: false,
        ctxState: 'running',
        handle: fakeHandle(),
        renderInfo: '',
      },
      attachTo: document.body,
    });

    expect(document.body.querySelector('.diag-status-on')).not.toBeNull();
    const text = document.body.textContent ?? '';
    expect(text).toContain('48000');
    // baseLatency 0.0053 s → 5.3 ms.
    expect(text).toContain('5.3');
    // ABI compatible badge.
    expect(document.body.querySelector('.diag-ok')).not.toBeNull();
  });

  it('emits close from the footer button', async () => {
    wrapper = mount(DiagnosticsPanel, {
      props: { open: true, busy: false, ctxState: '', handle: null, renderInfo: '' },
      attachTo: document.body,
    });

    const closeButton = document.body.querySelector('.modal-foot button') as HTMLButtonElement;
    closeButton.click();
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('close')).toBeTruthy();
  });
});
