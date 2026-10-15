/**
 * Focus-trap helpers for modal dialogs: keep Tab cycling inside a container.
 *
 * Pure DOM (no Vue dependency) so it is unit-testable under jsdom; visibility
 * checks avoid layout APIs (offsetParent) that jsdom does not implement.
 */

/** Selector matching natively focusable elements plus positive tabindex hosts. */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** True when the element is rendered as far as non-layout checks can tell. */
function isVisible(element: HTMLElement): boolean {
  if (element.hidden) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;
  if (element.closest('[hidden]') !== null) return false;
  return true;
}

/**
 * Lists the keyboard-focusable elements inside a container, in DOM order.
 *
 * @param container Root element to search under (not included itself).
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const nodes = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  return [...nodes].filter(isVisible);
}

/**
 * Handles a Tab keydown so focus wraps within the container.
 *
 * Call from the container's keydown listener; non-Tab keys are ignored.
 *
 * @param event The keydown event.
 * @param container The trap container.
 * @returns True when the event was handled (focus moved and default prevented).
 */
export function wrapTabFocus(event: KeyboardEvent, container: HTMLElement): boolean {
  if (event.key !== 'Tab') return false;
  const focusable = getFocusableElements(container);
  if (focusable.length === 0) {
    // Nothing to cycle through; keep focus pinned on the container.
    event.preventDefault();
    container.focus();
    return true;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = container.ownerDocument.activeElement;
  if (event.shiftKey) {
    if (active === first || active === container || !container.contains(active)) {
      event.preventDefault();
      last.focus();
      return true;
    }
    return false;
  }
  if (active === last || !container.contains(active)) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}
