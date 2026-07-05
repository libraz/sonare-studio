import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ErrorBanner from '@/components/shell/ErrorBanner.vue';

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
});

describe('ErrorBanner', () => {
  it('renders nothing when the message is empty', () => {
    wrapper = mount(ErrorBanner, { props: { message: '' } });
    expect(wrapper.find('.error-box').exists()).toBe(false);
  });

  it('shows the message with an alert role', () => {
    wrapper = mount(ErrorBanner, { props: { message: 'Boom' } });
    const box = wrapper.find('.error-box');
    expect(box.exists()).toBe(true);
    expect(box.attributes('role')).toBe('alert');
    expect(wrapper.find('.error-text').text()).toBe('Boom');
  });

  it('emits dismiss when the close button is clicked', async () => {
    wrapper = mount(ErrorBanner, { props: { message: 'Autosave failed' } });
    await wrapper.find('.error-dismiss').trigger('click');
    expect(wrapper.emitted('dismiss')).toHaveLength(1);
  });

  it('exposes an accessible label on the dismiss control', () => {
    wrapper = mount(ErrorBanner, { props: { message: 'oops' } });
    const button = wrapper.find('.error-dismiss');
    expect(button.attributes('aria-label')).toBeTruthy();
  });

  it('auto-dismisses visible messages after the configured delay', () => {
    vi.useFakeTimers();
    wrapper = mount(ErrorBanner, { props: { autoDismissMs: 1000, message: 'Temporary error' } });

    vi.advanceTimersByTime(999);
    expect(wrapper.emitted('dismiss')).toBeUndefined();

    vi.advanceTimersByTime(1);
    expect(wrapper.emitted('dismiss')).toHaveLength(1);
  });

  it('resets the auto-dismiss timer when the message changes', async () => {
    vi.useFakeTimers();
    wrapper = mount(ErrorBanner, { props: { autoDismissMs: 1000, message: 'First error' } });

    vi.advanceTimersByTime(750);
    await wrapper.setProps({ message: 'Second error' });
    vi.advanceTimersByTime(749);
    expect(wrapper.emitted('dismiss')).toBeUndefined();

    vi.advanceTimersByTime(251);
    expect(wrapper.emitted('dismiss')).toHaveLength(1);
  });

  it('allows auto-dismiss to be disabled', () => {
    vi.useFakeTimers();
    wrapper = mount(ErrorBanner, { props: { autoDismissMs: 0, message: 'Persistent error' } });

    vi.advanceTimersByTime(60_000);
    expect(wrapper.emitted('dismiss')).toBeUndefined();
  });
});
