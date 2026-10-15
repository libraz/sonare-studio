/** Parsers for the sample editor's free-text numeric inputs. */

/** Parses a finite number from text; null for blank or non-numeric input. */
export function parseNumber(value: string): number | null {
  const parsed = Number(value);
  return value.trim().length > 0 && Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parses a percentage and maps it to a [0, 1] fraction, clamping to [0, 100].
 *
 * @param value Input text.
 * @param fallbackPercent Percentage used when the text is not a number.
 */
export function parsePercentFraction(value: string, fallbackPercent: number): number {
  const percent = parseNumber(value) ?? fallbackPercent;
  return Math.min(Math.max(percent, 0), 100) / 100;
}
