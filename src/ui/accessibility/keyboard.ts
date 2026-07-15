/**
 * Whether Enter belongs to a control with its own native activation contract.
 *
 * Modal shells use this before forwarding Enter to dialog-level default
 * actions. Text-like inputs intentionally return false so dialogs can still
 * support Enter-to-confirm while a name/search field owns focus.
 */
export function hasNativeEnterBehavior(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;

  if (
    target.closest(
      'button, a[href], select, textarea, summary, [role="button"], [role="menuitem"], [role="option"], [contenteditable="true"]',
    ) !== null
  ) {
    return true;
  }

  const input = target.closest('input');
  if (!(input instanceof HTMLInputElement)) return false;
  return !['text', 'search', 'number', 'email', 'url', 'tel', 'password'].includes(input.type);
}
