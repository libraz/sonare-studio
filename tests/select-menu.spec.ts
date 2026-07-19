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

  it('announces the active option through aria-activedescendant on the combobox', async () => {
    const wrapper = mountMenu();
    const trigger = wrapper.find('button');
    // Closed: combobox role is present, no active descendant, no controls.
    expect(trigger.attributes('role')).toBe('combobox');
    expect(trigger.attributes('aria-activedescendant')).toBeUndefined();
    expect(trigger.attributes('aria-controls')).toBeUndefined();

    await trigger.trigger('click');
    const list = document.body.querySelector('.select-list') as HTMLElement;
    const listId = list.id;
    expect(listId).toBeTruthy();
    // Open on the selected value ('a', index 0): activedescendant points at it.
    expect(trigger.attributes('aria-controls')).toBe(listId);
    const active = trigger.attributes('aria-activedescendant');
    expect(active).toBe(`${listId}-option-0`);
    expect(document.getElementById(active as string)?.textContent).toContain('Alpha');

    // Arrowing down moves the active descendant to the next option's id.
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    const next = trigger.attributes('aria-activedescendant');
    expect(next).toBe(`${listId}-option-1`);
    expect(document.getElementById(next as string)?.textContent).toContain('Beta');
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
