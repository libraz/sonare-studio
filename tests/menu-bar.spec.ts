import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
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

  it('uses the focused menu as aria-activedescendant owner', async () => {
    const wrapper = mount(MenuBar, {
      attachTo: document.body,
      props: { menus, ariaLabel: 'Application menus' },
      global: { stubs: { TransportIcon: true } },
    });
    const bar = wrapper.find('[role="menubar"]');
    const trigger = wrapper.find('.app-menubar__trigger');
    expect(bar.attributes('aria-label')).toBe('Application menus');
    expect(trigger.attributes('role')).toBe('menuitem');
    (trigger.element as HTMLButtonElement).focus();

    await trigger.trigger('keydown', { key: 'ArrowDown' });
    await nextTick();

    const panel = wrapper.find<HTMLElement>('[role="menu"]');
    const item = wrapper.find<HTMLElement>('.menu-panel__item');
    expect(document.activeElement).toBe(panel.element);
    expect(panel.attributes('aria-activedescendant')).toBe(item.element.id);
    expect(trigger.attributes('aria-controls')).toBe(panel.element.id);
    wrapper.unmount();
    document.body.replaceChildren();
  });
});
