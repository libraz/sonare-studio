import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import MenuBar from '@/components/shell/MenuBar.vue';
import type { MenuBarMenu } from '@/ui/menu/menu-bar';

describe('MenuBar', () => {
  const menus: MenuBarMenu[] = [
    {
      id: 'file',
      label: 'File',
      items: [{ id: 'new', label: 'New', run: vi.fn() }],
    },
  ];

  it('removes the outside-click listener when unmounted while a menu is open', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const wrapper = mount(MenuBar, {
      props: { menus },
      global: {
        stubs: {
          TransportIcon: true,
        },
      },
    });

    await wrapper.find('.app-menubar__trigger').trigger('click');

    expect(add).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    wrapper.unmount();
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
  });
});
