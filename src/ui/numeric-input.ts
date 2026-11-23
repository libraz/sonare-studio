/** Values a `type="number"` input's v-model holds, and how they read as numbers. */

/** What a `type="number"` input's v-model holds: Vue writes a number, or the raw text when blank or unparseable. */
export type NumericInputValue = string | number;

/** True when a number input holds no text. */
export function isBlankInput(value: NumericInputValue): boolean {
  return String(value).trim().length === 0;
}

/** Parses a finite number from an input value; null for blank or non-numeric input. */
export function parseNumber(value: NumericInputValue): number | null {
  if (isBlankInput(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The finite number an input event's target holds; null when blank or non-numeric. */
export function readInputNumber(event: Event): number | null {
  return parseNumber((event.target as HTMLInputElement).value);
}

/**
 * Shows `value` again in the event's input. Call it only when an edit is
 * committed or abandoned (change, blur, Enter), never on `input`, so a user can
 * clear the field on the way to typing a new number.
 */
export function restoreInputValue(event: Event, value: number | string): void {
  (event.target as HTMLInputElement).value = String(value);
}

/**
 * On a committed edit (`change`), shows `value` again when the field holds no
 * number; for fields whose `input` handler already skips blank text.
 */
export function restoreUnreadableInput(event: Event, value: number | string): void {
  if (readInputNumber(event) === null) restoreInputValue(event, value);
}
