import type { Directive } from 'vue';

/**
 * Roving-tabindex machinery shared by the composite widgets whose options live
 * in one container: radio groups (segmented controls) and tab strips.
 *
 * Both follow the same WAI-ARIA contract — Tab reaches the widget once, landing
 * on the selected option, and the arrow keys move between options while the
 * selection follows focus. Only the child role and the attribute that marks the
 * selected child differ, so the behaviour is defined once here.
 */

/** Keys these directives consume; anything else falls through untouched. */
const NAVIGATION_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/**
 * Resolves the option a navigation key moves to, wrapping at both ends.
 *
 * @param key - `KeyboardEvent.key` value.
 * @param current - Index of the focused option, or -1 when none is focused.
 * @param count - Number of selectable options in the widget.
 * @returns Target index, or null when the key does not navigate.
 */
export function nextRovingIndex(key: string, current: number, count: number): number | null {
  if (count <= 0 || !NAVIGATION_KEYS.has(key)) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const step = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  // An unfocused widget enters at the first option going forward, last going back.
  if (current < 0) return step > 0 ? 0 : count - 1;
  return (current + step + count) % count;
}

/** Shape of the widget a roving directive drives. */
export interface RovingGroup {
  /** ARIA role carried by the options the container owns. */
  readonly role: string;
  /** Attribute whose `"true"` value marks the selected option. */
  readonly selectedAttribute: 'aria-checked' | 'aria-selected';
}

/**
 * Builds a directive that gives one container the roving-tabindex behaviour.
 *
 * The options need no changes: they are read from the DOM on every interaction,
 * so a widget whose options come from `v-for` stays declarative.
 *
 * @param group - Role and selection attribute of the options.
 */
export function createRovingDirective(group: RovingGroup): Directive<HTMLElement, unknown> {
  const selector = `[role="${group.role}"]`;

  /** Enabled options of the widget, in DOM order. */
  const optionsOf = (el: HTMLElement): HTMLElement[] =>
    Array.from(el.querySelectorAll<HTMLElement>(selector)).filter(
      (option) =>
        !option.hasAttribute('disabled') && option.getAttribute('aria-disabled') !== 'true',
    );

  /** Index of the selected option, or -1 when none is marked. */
  const selectedIndexOf = (options: HTMLElement[]): number =>
    options.findIndex((option) => option.getAttribute(group.selectedAttribute) === 'true');

  /**
   * Applies the roving tabindex: the selected option is the widget's single tab
   * stop, falling back to the first one when nothing is selected yet.
   */
  const syncTabStops = (el: HTMLElement): void => {
    const options = optionsOf(el);
    if (options.length === 0) return;
    const selected = selectedIndexOf(options);
    const stop = Math.max(selected, 0);
    options.forEach((option, index) => {
      option.tabIndex = index === stop ? 0 : -1;
    });
  };

  const onKeydown = (event: KeyboardEvent): void => {
    const el = event.currentTarget as HTMLElement;
    const options = optionsOf(el);
    if (options.length === 0) return;
    const focused = options.indexOf(document.activeElement as HTMLElement);
    // A key can reach the widget while focus sits on the container rather than
    // an option. Navigating from the selected option then matches what the user
    // sees; entering at an end would jump past the state on screen.
    const current = focused >= 0 ? focused : selectedIndexOf(options);
    const next = nextRovingIndex(event.key, current, options.length);
    if (next === null || next === current) return;
    event.preventDefault();
    const target = options[next];
    // Selection follows focus: focus first so the click lands on a focused
    // option, matching how a native radio group behaves under the arrow keys.
    target.focus();
    target.click();
    syncTabStops(el);
  };

  return {
    mounted(el) {
      el.addEventListener('keydown', onKeydown);
      syncTabStops(el);
    },
    updated(el) {
      syncTabStops(el);
    },
    beforeUnmount(el) {
      el.removeEventListener('keydown', onKeydown);
    },
  };
}
