/** True when a keyboard event originates from a text-editing element. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  // jsdom does not implement isContentEditable.
  const contentEditable = target.getAttribute('contenteditable');
  return contentEditable === '' || contentEditable === 'true';
}
