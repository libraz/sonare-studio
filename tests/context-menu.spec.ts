import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ContextMenuItem,
  cleanItems,
  closeContextMenu,
  openContextMenu,
  useContextMenuState,
} from '@/ui/menu/context-menu';

const noop = (): void => {};

afterEach(() => {
  closeContextMenu();
  document.body.textContent = '';
});

describe('cleanItems', () => {
  it('drops leading, trailing and doubled separators', () => {
    const items: ContextMenuItem[] = [
      { id: 's0', separator: true },
      { id: 'a', label: 'A', run: noop },
      { id: 's1', separator: true },
      { id: 's2', separator: true },
      { id: 'b', label: 'B', run: noop },
      { id: 's3', separator: true },
    ];
    expect(cleanItems(items).map((i) => i.id)).toEqual(['a', 's1', 'b']);
  });

  it('keeps a single separator between actions', () => {
    const items: ContextMenuItem[] = [
      { id: 'a', label: 'A', run: noop },
      { id: 's', separator: true },
      { id: 'b', label: 'B', run: noop },
    ];
    expect(cleanItems(items).map((i) => i.id)).toEqual(['a', 's', 'b']);
  });

  it('cleans submenu items and drops empty submenus', () => {
    const items: ContextMenuItem[] = [
      {
        id: 'sub',
        label: 'Sub',
        children: [
          { id: 's0', separator: true },
          { id: 'a', label: 'A', run: noop },
          { id: 's1', separator: true },
        ],
      },
      { id: 'empty', label: 'Empty', children: [{ id: 'sep', separator: true }] },
    ];
    const cleaned = cleanItems(items);
    expect(cleaned.map((i) => i.id)).toEqual(['sub']);
    expect(cleaned[0].children?.map((i) => i.id)).toEqual(['a']);
  });
});

describe('openContextMenu', () => {
  it('opens at the given coordinates with actionable items', () => {
    const state = useContextMenuState();
    openContextMenu(120, 48, [{ id: 'a', label: 'A', run: noop }]);
    expect(state.open).toBe(true);
    expect(state.x).toBe(120);
    expect(state.y).toBe(48);
    expect(state.items.map((i) => i.id)).toEqual(['a']);
  });

  it('drops items with neither a run nor a separator', () => {
    const state = useContextMenuState();
    openContextMenu(0, 0, [
      { id: 'dead', label: 'Dead' },
      { id: 'live', label: 'Live', run: noop },
    ]);
    expect(state.items.map((i) => i.id)).toEqual(['live']);
  });

  it('opens when an item only has actionable submenu children', () => {
    const state = useContextMenuState();
    openContextMenu(0, 0, [
      { id: 'sub', label: 'Sub', children: [{ id: 'child', label: 'Child', run: noop }] },
    ]);
    expect(state.open).toBe(true);
    expect(state.items.map((i) => i.id)).toEqual(['sub']);
    expect(state.items[0].children?.map((i) => i.id)).toEqual(['child']);
  });

  it('does not open a menu that has no actionable item', () => {
    const state = useContextMenuState();
    openContextMenu(0, 0, [
      { id: 'dead', label: 'Dead' },
      { id: 'sep', separator: true },
    ]);
    expect(state.open).toBe(false);
  });

  it('closes on Escape', () => {
    const state = useContextMenuState();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    openContextMenu(10, 10, [{ id: 'a', label: 'A', run: noop }]);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(state.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on a pointer press outside the menu', () => {
    const state = useContextMenuState();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    openContextMenu(10, 10, [{ id: 'a', label: 'A', run: noop }]);
    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(state.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});

describe('closeContextMenu', () => {
  it('clears the open state and items', () => {
    const state = useContextMenuState();
    openContextMenu(10, 10, [{ id: 'a', label: 'A', run: noop }]);
    closeContextMenu();
    expect(state.open).toBe(false);
    expect(state.items).toEqual([]);
  });

  it('removes global close listeners', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    openContextMenu(10, 10, [{ id: 'a', label: 'A', run: noop }]);

    expect(add).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(add).toHaveBeenCalledWith('keydown', expect.any(Function), true);

    closeContextMenu();

    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function), true);
  });

  it('uses the app-shell fallback when the opener was removed', () => {
    const shell = document.createElement('main');
    shell.tabIndex = -1;
    shell.dataset.appShellFocusFallback = '';
    const trigger = document.createElement('button');
    shell.append(trigger);
    document.body.append(shell);
    trigger.focus();

    openContextMenu(10, 10, [{ id: 'a', label: 'A', run: noop }]);
    trigger.remove();
    closeContextMenu();

    expect(document.activeElement).toBe(shell);
  });
});
