import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import ErrorBanner from '@/components/shell/ErrorBanner.vue';

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
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
    expect(button.attributes('title')).toBe(button.attributes('aria-label'));
  });
});
