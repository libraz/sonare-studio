import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ContextMenu from '@/components/shell/ContextMenu.vue';
import { closeContextMenu, openContextMenu } from '@/ui/menu/context-menu';

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
  wrapper?.unmount();
  wrapper = null;
  document.body.textContent = '';
});

describe('ContextMenu keyboard navigation', () => {
  it('focuses the first enabled item when opened', async () => {
    await mountOpenMenu([
      { id: 'disabled', label: 'Disabled', disabled: true, run: vi.fn() },
      { id: 'first', label: 'First', run: vi.fn() },
    ]);

    expect(document.activeElement).toBe(document.querySelector('[data-menu-item-id="first"]'));
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
});
