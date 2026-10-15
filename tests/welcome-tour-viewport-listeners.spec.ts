import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import WelcomeTour from '@/components/onboarding/WelcomeTour.vue';

describe('WelcomeTour viewport listeners', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="anchor"></div>';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function mountTour() {
    return mount(WelcomeTour, {
      props: {
        autoStart: false,
        steps: [{ id: 'one', target: '#anchor', title: 'One', body: 'First step' }],
      },
      attachTo: document.body,
    });
  }

  it('listens to scroll and resize only while the tour is visible', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const wrapper = mountTour();
    expect(add).not.toHaveBeenCalledWith('scroll', expect.any(Function), true);

    (wrapper.vm as unknown as { open: () => void }).open();
    await nextTick();
    expect(add).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(add).toHaveBeenCalledWith('resize', expect.any(Function));

    await wrapper.get('.tour-skip').trigger('click');
    await nextTick();
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
    wrapper.unmount();
  });

  it('re-measures the anchor once per frame however many scrolls arrive', async () => {
    const wrapper = mountTour();
    (wrapper.vm as unknown as { open: () => void }).open();
    await nextTick();
    await vi.runAllTimersAsync();
    const measure = vi.spyOn(document.getElementById('anchor') as Element, 'getBoundingClientRect');

    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    await vi.runAllTimersAsync();

    expect(measure).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
