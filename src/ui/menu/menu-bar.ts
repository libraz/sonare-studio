/**
 * Declarative model for the application menu bar (the File / Edit / View /
 * Transport / Help row beside the brand mark, and the right-aligned Layout
 * menu). One shared shape drives every top-level menu so they render, navigate
 * and behave identically — the same check column, shortcut-hint column,
 * separators and section headings throughout.
 *
 * This is deliberately distinct from the right-click `context-menu` store: that
 * one is a singleton positioned at a pointer location, whereas these menus are
 * anchored to their bar triggers and support keyboard menu-to-menu traversal.
 */

/** A single row in a menu-bar dropdown. */
export interface MenuBarItem {
  /** Stable key within the menu. */
  id: string;
  /** Display label (omitted for separators and headings). */
  label?: string;
  /** Right-aligned shortcut hint, e.g. the key that also performs the action. */
  hint?: string;
  /** Shows a leading check mark, e.g. for the active option or an on toggle. */
  checked?: boolean;
  /** Greys the item out and ignores activation. */
  disabled?: boolean;
  /** Why the item is unavailable, shown on hover; a non-empty reason also disables it. */
  disabledReason?: string | null;
  /** Renders the item with destructive styling. */
  danger?: boolean;
  /** Renders a divider line instead of an action row. */
  separator?: boolean;
  /** Renders a non-interactive section heading instead of an action row. */
  heading?: string;
  /** Action run on activation; the menu closes first, then the action runs. */
  run?: () => void;
}

/** One top-level menu in the bar. */
export interface MenuBarMenu {
  /** Stable key within the bar. */
  id: string;
  /** Trigger label shown in the bar. */
  label: string;
  /** Accessible name for the open dropdown. */
  ariaLabel?: string;
  /** Rows of the dropdown; rebuilt reactively so open menus stay live. */
  items: MenuBarItem[];
}

/** True when the item is greyed out, by flag or by a stated reason. */
export function isItemDisabled(item: MenuBarItem): boolean {
  return Boolean(item.disabled || item.disabledReason);
}

/** True when an item can receive keyboard focus / be activated. */
export function isNavigable(item: MenuBarItem): boolean {
  return !item.separator && !item.heading && !isItemDisabled(item) && Boolean(item.run);
}

/**
 * Drops separators that would render as a leading, trailing or doubled divider
 * once conditionally-omitted rows are gone, and headings left with no following
 * item, so a menu never shows a stray line or dangling heading.
 */
export function cleanMenuItems(items: readonly MenuBarItem[]): MenuBarItem[] {
  const out: MenuBarItem[] = [];
  for (const item of items) {
    if (item.separator) {
      if (out.length === 0 || out[out.length - 1].separator || out[out.length - 1].heading) {
        continue;
      }
      out.push(item);
    } else {
      out.push(item);
    }
  }
  // Trim trailing separators, and headings with nothing beneath them.
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last.separator || last.heading) out.pop();
    else break;
  }
  return out;
}
