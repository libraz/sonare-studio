import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SelectMenu from '@/components/shell/SelectMenu.vue';

describe('SelectMenu', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function mountMenu() {
    return mount(SelectMenu, {
      props: {
        ariaLabel: 'Mode',
        modelValue: 'a',
        options: [
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
          { value: 'c', label: 'Charlie' },
        ],
      },
      attachTo: document.body,
    });
  }

  it('removes global listeners when unmounted while open', async () => {
    const addDocument = vi.spyOn(document, 'addEventListener');
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    const addWindow = vi.spyOn(window, 'addEventListener');
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const wrapper = mountMenu();

    await wrapper.find('button').trigger('click');
    expect(addDocument).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(addWindow).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(addWindow).toHaveBeenCalledWith('scroll', expect.any(Function), true);

    wrapper.unmount();

    expect(removeDocument).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(removeWindow).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith('scroll', expect.any(Function), true);
  });

  it('clears typeahead timer on unmount', async () => {
    const wrapper = mountMenu();
    await wrapper.find('button').trigger('click');
    await wrapper.find('button').trigger('keydown', { key: 'c' });
    expect(document.body.querySelector('.select-option.is-active')?.textContent).toContain(
      'Charlie',
    );

    wrapper.unmount();
    vi.advanceTimersByTime(600);

    expect(document.body.querySelector('.select-list')).toBeNull();
  });
});
