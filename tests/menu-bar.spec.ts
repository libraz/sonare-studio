import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import MenuBar from '@/components/shell/MenuBar.vue';
import type { MenuBarMenu } from '@/ui/menu/menu-bar';
import {
  resetShortcutBlockingOverlaysForTest,
  shortcutBlockingOverlayOpen,
} from '@/ui/overlay-registry';

afterEach(() => {
  resetShortcutBlockingOverlaysForTest();
  document.body.replaceChildren();
});

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

  it('blocks global shortcuts only while a menu is open', async () => {
    const wrapper = mount(MenuBar, {
      props: { menus },
      global: { stubs: { TransportIcon: true } },
    });

    expect(shortcutBlockingOverlayOpen.value).toBe(false);
    await wrapper.find('.app-menubar__trigger').trigger('click');
    expect(shortcutBlockingOverlayOpen.value).toBe(true);
    await wrapper.find('.app-menubar__trigger').trigger('click');
    expect(shortcutBlockingOverlayOpen.value).toBe(false);
    wrapper.unmount();
  });

  it('exposes toggleable rows as menuitemcheckbox with aria-checked', async () => {
    const toggleMenus: MenuBarMenu[] = [
      {
        id: 'view',
        label: 'View',
        items: [
          { id: 'grid', label: 'Show grid', checked: true, run: vi.fn() },
          { id: 'about', label: 'About', run: vi.fn() },
        ],
      },
    ];
    const wrapper = mount(MenuBar, {
      attachTo: document.body,
      props: { menus: toggleMenus },
      global: { stubs: { TransportIcon: true } },
    });
    await wrapper.find('.app-menubar__trigger').trigger('click');
    await nextTick();

    const rows = wrapper.findAll('.menu-panel__item');
    const grid = rows.find((row) => row.text().includes('Show grid'));
    const about = rows.find((row) => row.text().includes('About'));
    // A checkable row must announce its state through the checkbox role;
    // aria-checked on a plain menuitem is not conveyed by assistive tech.
    expect(grid?.attributes('role')).toBe('menuitemcheckbox');
    expect(grid?.attributes('aria-checked')).toBe('true');
    // A plain action row keeps the menuitem role with no checked state.
    expect(about?.attributes('role')).toBe('menuitem');
    expect(about?.attributes('aria-checked')).toBeUndefined();
    wrapper.unmount();
    document.body.replaceChildren();
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
