import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AddTrackMenu from '@/components/arrangement/track-header/AddTrackMenu.vue';

describe('AddTrackMenu', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('emits the selected track kind and closes the menu', async () => {
    const wrapper = mount(AddTrackMenu, {
      global: {
        directives: {
          tooltip: () => undefined,
        },
      },
    });

    await wrapper.find('.add-track').trigger('click');
    await wrapper.findAll('.add-track-items button')[1].trigger('click');

    expect(wrapper.emitted('add')).toEqual([['audio']]);
    expect(wrapper.find('.add-track-items').exists()).toBe(false);
  });

  it('removes the outside-click listener on unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const wrapper = mount(AddTrackMenu, {
      global: {
        directives: {
          tooltip: () => undefined,
        },
      },
    });

    await wrapper.find('.add-track').trigger('click');

    expect(add).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    wrapper.unmount();
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
  });
});
