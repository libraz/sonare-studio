/**
 * App-wide right-click action menu. A single ContextMenu component is mounted
 * once at the shell; any surface opens it by calling `openContextMenu(x, y,
 * items)` with the actions valid for what was clicked. Items are plain command
 * runners, and only genuinely wired actions are ever listed, so the menu has no
 * dead entries.
 *
 * This is intentionally separate from the mixer control menu
 * (use-control-interactions.ts), which is a per-control value reset/copy/paste
 * popup; this menu is a shared list of arbitrary actions positioned at a
 * right-click.
 */

import { reactive } from 'vue';

/** A single entry in a right-click action menu. */
export interface ContextMenuItem {
  /** Stable key within the menu. */
  id: string;
  /** Display label (ignored for separators). */
  label?: string;
  /** Right-aligned shortcut hint, e.g. the key that also performs the action. */
  hint?: string;
  /** Shows a leading check mark, e.g. for the active option or an on toggle. */
  checked?: boolean;
  /** Action run on click; the menu closes first, then the action runs. */
  run?: () => unknown | Promise<unknown>;
  /** Nested actions shown as a submenu. */
  children?: ContextMenuItem[];
  /** Greys the item out and ignores clicks. */
  disabled?: boolean;
  /** Renders the item with destructive styling. */
  danger?: boolean;
  /** True renders a divider line instead of an action item. */
  separator?: boolean;
}

/** Reactive state backing the singleton ContextMenu component. */
export interface ContextMenuState {
  /** Whether the menu is shown. */
  open: boolean;
  /** Viewport x of the menu's top-left, in px. */
  x: number;
  /** Viewport y of the menu's top-left, in px. */
  y: number;
  /** Items currently shown (cleaned of stray separators). */
  items: ContextMenuItem[];
  /** Most recent action failure, consumed by the app-level error banner. */
  error: string;
}

const state = reactive<ContextMenuState>({ open: false, x: 0, y: 0, items: [], error: '' });

/** Publishes a menu action failure without leaving a rejected promise unhandled. */
export function reportContextMenuError(error: unknown): void {
  state.error = error instanceof Error ? error.message : String(error);
}

let outsideHandler: ((event: PointerEvent) => void) | null = null;
let keyHandler: ((event: KeyboardEvent) => void) | null = null;
/** Focused element before the current menu generation opened. */
let previousFocus: HTMLElement | null = null;
let openGeneration = 0;

function detachListeners(): void {
  if (outsideHandler) {
    window.removeEventListener('pointerdown', outsideHandler, true);
    outsideHandler = null;
  }
  if (keyHandler) {
    window.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
  }
}

/**
 * Returns keyboard focus to the invoking control, or to the app shell when
 * that control was removed by the action that closed the menu.
 */
function restoreFocus(generation: number): void {
  if (generation !== openGeneration) return;
  const target = previousFocus;
  previousFocus = null;
  if (target?.isConnected) {
    target.focus();
    return;
  }
  const fallback = document.querySelector<HTMLElement>('[data-app-shell-focus-fallback]');
  fallback?.focus();
}

/** Restores focus for a deferred action close, unless another menu superseded it. */
export function restoreContextMenuFocus(generation: number | null): void {
  if (generation !== null) restoreFocus(generation);
}

/**
 * Drops separators that would render as a leading, trailing or doubled divider
 * once conditionally-omitted actions are gone, so a menu never shows a stray
 * line.
 */
export function cleanItems(items: readonly ContextMenuItem[]): ContextMenuItem[] {
  const out: ContextMenuItem[] = [];
  for (const item of items) {
    if (item.separator) {
      if (out.length === 0 || out[out.length - 1].separator) continue;
      out.push(item);
    } else {
      const children = item.children ? cleanItems(item.children) : undefined;
      if (item.children && !children?.some((child) => !child.separator)) continue;
      out.push(children ? { ...item, children } : item);
    }
  }
  while (out.length > 0 && out[out.length - 1].separator) out.pop();
  return out;
}

/** Options controlling focus ownership while closing a menu. */
export interface CloseContextMenuOptions {
  /**
   * Restore focus immediately (the default). Actions defer this until after
   * their synchronous DOM changes, so a deleted opener falls back correctly.
   */
  restoreFocus?: boolean;
}

/** Closes the menu, removes its listeners, and returns its close generation. */
export function closeContextMenu(options: CloseContextMenuOptions = {}): number | null {
  if (!state.open) return null;
  const generation = openGeneration;
  state.open = false;
  state.items = [];
  detachListeners();
  if (options.restoreFocus !== false) restoreFocus(generation);
  return generation;
}

/**
 * Opens the action menu at the given viewport coordinates. Items with no `run`
 * and no `separator` are dropped, and a menu left with no actionable item is
 * not shown. The caller is responsible for suppressing the native menu (e.g.
 * `@contextmenu.prevent`).
 *
 * @param x - Viewport x of the click, in px.
 * @param y - Viewport y of the click, in px.
 * @param items - Candidate menu items; cleaned before display.
 */
export function openContextMenu(x: number, y: number, items: readonly ContextMenuItem[]): void {
  const usable = items.filter((item) => item.separator || item.run || item.children);
  const cleaned = cleanItems(usable);
  if (!cleaned.some((item) => !item.separator)) {
    closeContextMenu();
    return;
  }
  if (!state.open) {
    const active = document.activeElement;
    previousFocus = active instanceof HTMLElement ? active : null;
  }
  openGeneration += 1;
  state.items = cleaned;
  state.x = x;
  state.y = y;
  state.open = true;
  detachListeners();
  outsideHandler = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('.context-menu')) closeContextMenu();
  };
  keyHandler = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeContextMenu();
  };
  window.addEventListener('pointerdown', outsideHandler, true);
  window.addEventListener('keydown', keyHandler, true);
}

/** Returns the shared menu state for the singleton ContextMenu component. */
export function useContextMenuState(): ContextMenuState {
  return state;
}
