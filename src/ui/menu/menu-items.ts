/** Helpers shared by the menu-bar and right-click context menu item models. */

/** The fields of a menu row that disabling and separator cleanup depend on. */
export interface MenuRowShape {
  disabled?: boolean;
  disabledReason?: string | null;
  separator?: boolean;
  heading?: string;
}

/** True when the item is greyed out, by flag or by a stated reason. */
export function isItemDisabled(item: Pick<MenuRowShape, 'disabled' | 'disabledReason'>): boolean {
  return Boolean(item.disabled || item.disabledReason);
}

/**
 * Drops separators that would render as a leading, doubled or trailing divider
 * (or sit right under a heading) once conditionally-omitted rows are gone, and
 * trailing headings with nothing beneath them.
 */
export function trimStraySeparators<T extends MenuRowShape>(items: readonly T[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (item.separator) {
      const last = out[out.length - 1];
      if (last === undefined || last.separator || last.heading) continue;
    }
    out.push(item);
  }
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last.separator || last.heading) out.pop();
    else break;
  }
  return out;
}
