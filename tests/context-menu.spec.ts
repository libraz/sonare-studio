import { afterEach, describe, expect, it } from 'vitest';
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
    openContextMenu(10, 10, [{ id: 'a', label: 'A', run: noop }]);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(state.open).toBe(false);
  });

  it('closes on a pointer press outside the menu', () => {
    const state = useContextMenuState();
    openContextMenu(10, 10, [{ id: 'a', label: 'A', run: noop }]);
    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(state.open).toBe(false);
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
});
