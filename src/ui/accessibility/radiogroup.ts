import type { Directive } from 'vue';

/**
 * `v-radiogroup` — arrow-key navigation and roving tabindex for a container
 * marked `role="radiogroup"` whose children are `role="radio"` buttons.
 *
 * A segmented control is a radio group, and WAI-ARIA expects a radio group to
 * behave like one: Tab reaches the group once (landing on the checked option),
 * and the arrow keys move the selection between options. Without this a keyboard
 * user has to Tab through every segment, and a screen-reader user gets radios
 * that announce as radios but ignore the arrows.
 *
 * Bind it on the group root: `<div class="segmented" role="radiogroup"
 * v-radiogroup>`. The radios need no changes — the directive reads them from the
 * DOM, so a group whose options are rendered by `v-for` stays declarative.
 *
 * Selection follows focus (the WAI-ARIA radio-group pattern): moving with an
 * arrow key activates the option it lands on by clicking it, which runs whatever
 * handler the component already bound.
 */

/** Keys the directive consumes; anything else falls through untouched. */
const NAVIGATION_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/**
 * Resolves the option a navigation key moves to, wrapping at both ends.
 *
 * @param key - `KeyboardEvent.key` value.
 * @param current - Index of the focused option, or -1 when none is focused.
 * @param count - Number of selectable options in the group.
 * @returns Target index, or null when the key does not navigate.
 */
export function nextRadioIndex(key: string, current: number, count: number): number | null {
  if (count <= 0 || !NAVIGATION_KEYS.has(key)) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const step = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  // An unfocused group enters at the first option going forward, last going back.
  if (current < 0) return step > 0 ? 0 : count - 1;
  return (current + step + count) % count;
}

/** Enabled radios of a group, in DOM order. */
function radiosOf(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>('[role="radio"]')).filter(
    (radio) => !radio.hasAttribute('disabled') && radio.getAttribute('aria-disabled') !== 'true',
  );
}

/**
 * Applies the roving tabindex: the checked radio is the group's single tab stop,
 * falling back to the first one when nothing is checked yet.
 */
function syncTabStops(el: HTMLElement): void {
  const radios = radiosOf(el);
  if (radios.length === 0) return;
  const checked = radios.findIndex((radio) => radio.getAttribute('aria-checked') === 'true');
  const stop = checked >= 0 ? checked : 0;
  radios.forEach((radio, index) => {
    radio.tabIndex = index === stop ? 0 : -1;
  });
}

function onKeydown(event: KeyboardEvent): void {
  const el = event.currentTarget as HTMLElement;
  const radios = radiosOf(el);
  if (radios.length === 0) return;
  const current = radios.indexOf(document.activeElement as HTMLElement);
  const next = nextRadioIndex(event.key, current, radios.length);
  if (next === null || next === current) return;
  event.preventDefault();
  const target = radios[next];
  // Selection follows focus: focus first so the click lands on a focused radio,
  // matching how a native radio group behaves under the arrow keys.
  target.focus();
  target.click();
  syncTabStops(el);
}

/** The `v-radiogroup` directive. Register globally in main.ts. */
export const vRadioGroup: Directive<HTMLElement, unknown> = {
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
