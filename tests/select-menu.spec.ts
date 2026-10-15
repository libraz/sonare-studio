import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import {
  resetShortcutBlockingOverlaysForTest,
  shortcutBlockingOverlayOpen,
} from '@/ui/overlay-registry';

describe('SelectMenu', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    resetShortcutBlockingOverlaysForTest();
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
    const addWindow = vi.spyOn(window, 'addEventListener');
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const wrapper = mountMenu();

    await wrapper.find('button').trigger('click');
    expect(addWindow).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(addWindow).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(addWindow).toHaveBeenCalledWith('scroll', expect.any(Function), true);

    wrapper.unmount();

    expect(removeWindow).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(removeWindow).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith('scroll', expect.any(Function), true);
  });

  it('blocks global shortcuts while its listbox is open', async () => {
    const wrapper = mountMenu();
    expect(shortcutBlockingOverlayOpen.value).toBe(false);
    await wrapper.find('button').trigger('click');
    expect(shortcutBlockingOverlayOpen.value).toBe(true);
    await wrapper.find('button').trigger('click');
    expect(shortcutBlockingOverlayOpen.value).toBe(false);
    wrapper.unmount();
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

  it('skips disabled options for Home and End navigation', async () => {
    const wrapper = mount(SelectMenu, {
      props: {
        ariaLabel: 'Mode',
        modelValue: 'b',
        options: [
          { value: 'a', label: 'Alpha', disabled: true },
          { value: 'b', label: 'Beta' },
          { value: 'c', label: 'Charlie' },
          { value: 'd', label: 'Delta', disabled: true },
        ],
      },
      attachTo: document.body,
    });
    const trigger = wrapper.find('button');

    await trigger.trigger('click');
    await trigger.trigger('keydown', { key: 'End' });
    expect(trigger.attributes('aria-activedescendant')).toMatch(/option-2$/);
    await trigger.trigger('keydown', { key: 'Home' });
    expect(trigger.attributes('aria-activedescendant')).toMatch(/option-1$/);
  });

  it('repositions once per frame and ignores scrolls inside its own list', async () => {
    const wrapper = mountMenu();
    const trigger = wrapper.find('button').element;
    await wrapper.find('button').trigger('click');
    await vi.runAllTimersAsync();
    const measure = vi.spyOn(trigger, 'getBoundingClientRect');
    const list = document.body.querySelector('.select-list') as HTMLElement;

    list.dispatchEvent(new Event('scroll'));
    await vi.runAllTimersAsync();
    expect(measure).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    await vi.runAllTimersAsync();
    expect(measure).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
