/** Named display styles shared by date-bearing application surfaces. */
export type TimestampFormat = 'date' | 'time' | 'datetime';

/**
 * Formats a timestamp in the application's active locale.
 *
 * Callers can use a named style for the ordinary shell surfaces or pass Intl
 * options when a compact specialised presentation (such as the build stamp)
 * is required. Keeping the locale explicit avoids accidentally following the
 * browser locale after the user selected a different application language.
 */
export function formatTimestamp(
  value: Date | number,
  locale: string,
  presentation: TimestampFormat | Intl.DateTimeFormatOptions = 'datetime',
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (typeof presentation !== 'string') return date.toLocaleString(locale, presentation);
  switch (presentation) {
    case 'date':
      return date.toLocaleDateString(locale);
    case 'time':
      return date.toLocaleTimeString(locale);
    case 'datetime':
      return date.toLocaleString(locale);
  }
}
