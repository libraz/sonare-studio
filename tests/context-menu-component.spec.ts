import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ContextMenu from '@/components/shell/ContextMenu.vue';
import { closeContextMenu, openContextMenu, useContextMenuState } from '@/ui/menu/context-menu';
import {
  resetShortcutBlockingOverlaysForTest,
  shortcutBlockingOverlayOpen,
} from '@/ui/overlay-registry';

let wrapper: VueWrapper | null = null;

async function mountOpenMenu(items: Parameters<typeof openContextMenu>[2]): Promise<VueWrapper> {
  wrapper = mount(ContextMenu, { attachTo: document.body });
  openContextMenu(8, 12, items);
  await nextTick();
  await nextTick();
  return wrapper;
}

afterEach(() => {
  closeContextMenu();
  resetShortcutBlockingOverlaysForTest();
  useContextMenuState().error = '';
  wrapper?.unmount();
  wrapper = null;
  document.body.textContent = '';
});

describe('ContextMenu keyboard navigation', () => {
  it('blocks global shortcuts while the context menu is open', async () => {
    await mountOpenMenu([{ id: 'first', label: 'First', run: vi.fn() }]);
    expect(shortcutBlockingOverlayOpen.value).toBe(true);
    closeContextMenu();
    expect(shortcutBlockingOverlayOpen.value).toBe(false);
  });

  it('focuses the first enabled item when opened', async () => {
    await mountOpenMenu([
      { id: 'disabled', label: 'Disabled', disabled: true, run: vi.fn() },
      { id: 'first', label: 'First', run: vi.fn() },
    ]);

    expect(document.activeElement).toBe(document.querySelector('[data-menu-item-id="first"]'));
  });

  it('marks checkable items as menuitemcheckbox with aria-checked', async () => {
    await mountOpenMenu([
      { id: 'snap', label: 'Snap to grid', checked: true, run: vi.fn() },
      { id: 'mono', label: 'Mono monitor', checked: false, run: vi.fn() },
      { id: 'plain', label: 'Rename', run: vi.fn() },
    ]);

    const snap = document.querySelector('[data-menu-item-id="snap"]');
    const mono = document.querySelector('[data-menu-item-id="mono"]');
    const plain = document.querySelector('[data-menu-item-id="plain"]');
    // aria-checked only conveys state on a menuitemcheckbox/menuitemradio role.
    expect(snap?.getAttribute('role')).toBe('menuitemcheckbox');
    expect(snap?.getAttribute('aria-checked')).toBe('true');
    expect(mono?.getAttribute('role')).toBe('menuitemcheckbox');
    expect(mono?.getAttribute('aria-checked')).toBe('false');
    // A non-toggle item stays a plain menuitem with no checked state.
    expect(plain?.getAttribute('role')).toBe('menuitem');
    expect(plain?.getAttribute('aria-checked')).toBeNull();
  });

  it('moves focus with arrows and runs the focused item with Enter', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const w = await mountOpenMenu([
      { id: 'first', label: 'First', run: first },
      { id: 'second', label: 'Second', run: second },
    ]);

    await w.get('.context-menu').trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(document.querySelector('[data-menu-item-id="second"]'));

    await w.get('.context-menu').trigger('keydown', { key: 'Enter' });

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(document.querySelector('.context-menu')).toBeNull();
  });

  it('opens submenus from the keyboard and returns focus with ArrowLeft', async () => {
    const child = vi.fn();
    const w = await mountOpenMenu([
      {
        id: 'parent',
        label: 'Parent',
        children: [{ id: 'child', label: 'Child', run: child }],
      },
    ]);

    await w.get('.context-menu').trigger('keydown', { key: 'ArrowRight' });
    await nextTick();
    expect(document.activeElement).toBe(document.querySelector('[data-menu-item-id="child"]'));

    await w.get('.context-submenu').trigger('keydown', { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(document.querySelector('[data-menu-item-id="parent"]'));
  });

  it('publishes synchronous and asynchronous action failures for the app banner', async () => {
    let w = await mountOpenMenu([
      {
        id: 'sync-failure',
        label: 'Sync failure',
        run: () => {
          throw new Error('sync menu failure');
        },
      },
    ]);
    await w.get('[data-menu-item-id="sync-failure"]').trigger('click');
    expect(useContextMenuState().error).toBe('sync menu failure');

    useContextMenuState().error = '';
    openContextMenu(8, 12, [
      {
        id: 'async-failure',
        label: 'Async failure',
        run: async () => {
          throw new Error('async menu failure');
        },
      },
    ]);
    await nextTick();
    w = wrapper as VueWrapper;
    await w.get('[data-menu-item-id="async-failure"]').trigger('click');
    await flushPromises();
    expect(useContextMenuState().error).toBe('async menu failure');
  });

  it('uses the shell fallback when an action removes the opener', async () => {
    const shell = document.createElement('main');
    shell.tabIndex = -1;
    shell.dataset.appShellFocusFallback = '';
    const opener = document.createElement('button');
    shell.append(opener);
    document.body.append(shell);
    opener.focus();

    const w = await mountOpenMenu([{ id: 'remove', label: 'Remove', run: () => opener.remove() }]);
    await w.get('[data-menu-item-id="remove"]').trigger('click');
    await flushPromises();

    expect(document.activeElement).toBe(shell);
  });
});
