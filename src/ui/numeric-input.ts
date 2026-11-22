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
