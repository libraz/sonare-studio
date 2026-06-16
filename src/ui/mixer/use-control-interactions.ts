/**
 * Shared mouse-wheel and right-click-menu behavior for the mixer knob and
 * fader, layered on top of each control's own drag/keyboard logic. This brings
 * the controls in line with professional DAW conventions: scroll to adjust,
 * right-click for reset / copy / paste, double-click to reset (kept in the
 * controls themselves).
 *
 * The control still owns its value gesture and emits `(value, commit)`; this
 * composable only translates wheel and context-menu events into the same
 * commit-true edits, so undo coalescing is unaffected.
 */

import { onBeforeUnmount, reactive } from 'vue';
import { clampToRange, type DragRange } from './drag';

/** Module-level clipboard holding a single copied control value. */
let clipboardValue: number | null = null;

/** Reactive state for the floating control context menu. */
export interface ControlMenuState {
  /** Whether the menu is shown. */
  open: boolean;
  /** Viewport x of the menu's top-left, in px. */
  x: number;
  /** Viewport y of the menu's top-left, in px. */
  y: number;
}

/** Options wiring the composable to a specific control. */
export interface ControlInteractionsOptions {
  /** Reads the control's current value. */
  getValue: () => number;
  /** Reads the control bounds (for clamping a pasted value). */
  getRange: () => DragRange;
  /** Commits a new value (commit-true edit). */
  commit: (value: number) => void;
  /** One wheel notch / nudge in the given direction, fine when shift is held. */
  nudge: (direction: 1 | -1, fine: boolean) => void;
  /** Reset target, or undefined to disable reset. */
  getDefault?: () => number | undefined;
  /** True when the control is disabled (events are ignored). */
  isDisabled?: () => boolean;
}

/** The handlers and state a control binds to enable wheel + menu interactions. */
export interface ControlInteractions {
  /** Bound to `@wheel.prevent`. */
  onWheel: (event: WheelEvent) => void;
  /** Bound to `@contextmenu.prevent`. */
  onContextMenu: (event: MouseEvent) => void;
  /** Reactive menu state for the floating menu markup. */
  menu: ControlMenuState;
  /** Closes the menu. */
  closeMenu: () => void;
  /** Menu action: reset to the default value. */
  resetToDefault: () => void;
  /** Menu action: copy the current value to the shared clipboard. */
  copyValue: () => void;
  /** Menu action: paste the clipboard value (clamped to range). */
  pasteValue: () => void;
  /** True when a value is available to paste and reset is possible. */
  canReset: () => boolean;
  /** True when the clipboard holds a value to paste. */
  canPaste: () => boolean;
}

/** Wires wheel and right-click-menu behavior for one control. */
export function useControlInteractions(options: ControlInteractionsOptions): ControlInteractions {
  const menu = reactive<ControlMenuState>({ open: false, x: 0, y: 0 });

  function disabled(): boolean {
    return options.isDisabled?.() ?? false;
  }

  /** Closes the menu on any press outside of it. */
  function onOutsidePointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target?.closest('.control-menu')) closeMenu();
  }

  function openMenu(x: number, y: number): void {
    menu.open = true;
    menu.x = x;
    menu.y = y;
    window.addEventListener('pointerdown', onOutsidePointerDown, true);
  }

  function closeMenu(): void {
    if (!menu.open) return;
    menu.open = false;
    window.removeEventListener('pointerdown', onOutsidePointerDown, true);
  }

  function onWheel(event: WheelEvent): void {
    if (disabled() || event.deltaY === 0) return;
    event.preventDefault();
    options.nudge(event.deltaY < 0 ? 1 : -1, event.shiftKey);
  }

  function onContextMenu(event: MouseEvent): void {
    if (disabled()) return;
    event.preventDefault();
    openMenu(event.clientX, event.clientY);
  }

  function resetToDefault(): void {
    const target = options.getDefault?.();
    if (target !== undefined) options.commit(target);
    closeMenu();
  }

  function copyValue(): void {
    clipboardValue = options.getValue();
    closeMenu();
  }

  function pasteValue(): void {
    if (clipboardValue !== null) options.commit(clampToRange(clipboardValue, options.getRange()));
    closeMenu();
  }

  function canReset(): boolean {
    return options.getDefault?.() !== undefined;
  }

  function canPaste(): boolean {
    return clipboardValue !== null;
  }

  onBeforeUnmount(closeMenu);

  return {
    onWheel,
    onContextMenu,
    menu,
    closeMenu,
    resetToDefault,
    copyValue,
    pasteValue,
    canReset,
    canPaste,
  };
}
