/**
 * True while a keydown belongs to an IME composition, so Enter that confirms a
 * conversion must not also commit the field. `keyCode === 229` covers browsers
 * that clear `isComposing` on the confirming keydown.
 */
export function isImeComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}
