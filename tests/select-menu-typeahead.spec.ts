import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SelectMenu from '@/components/shell/SelectMenu.vue';

describe('SelectMenu typeahead', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  async function openMenu(modelValue = 'a') {
    const wrapper = mount(SelectMenu, {
      props: {
        ariaLabel: 'Mode',
        modelValue,
        options: [
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Big band' },
          { value: 'c', label: 'Big beat' },
        ],
      },
      attachTo: document.body,
    });
    await wrapper.find('button').trigger('click');
    return wrapper;
  }

  const active = () =>
    [...document.body.querySelectorAll('[role="option"]')].findIndex((o) =>
      o.classList.contains('is-active'),
    );

  it('extends the typeahead with a space instead of choosing', async () => {
    const wrapper = await openMenu();
    const button = wrapper.find('button');
    await button.trigger('keydown', { key: 'b' });
    await button.trigger('keydown', { key: 'i' });
    await button.trigger('keydown', { key: 'g' });
    await button.trigger('keydown', { key: ' ' });
    await button.trigger('keydown', { key: 'b' });
    await button.trigger('keydown', { key: 'e' });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(active()).toBe(2);
  });

  it('still chooses on a space when no typeahead is pending', async () => {
    const wrapper = await openMenu();
    const button = wrapper.find('button');
    await button.trigger('keydown', { key: 'ArrowDown' });
    await button.trigger('keydown', { key: ' ' });
    expect(wrapper.emitted('update:modelValue')).toEqual([['b']]);
  });

  it('ignores typeahead while a modifier is held', async () => {
    const wrapper = await openMenu('c');
    await wrapper.find('button').trigger('keydown', { key: 'a', metaKey: true });
    expect(active()).toBe(2);
  });
});
