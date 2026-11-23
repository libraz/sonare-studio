/** A cancelable Enter keydown, optionally flagged as an IME composition key. */
export function enterKey(composing: boolean): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    isComposing: composing,
  });
}
