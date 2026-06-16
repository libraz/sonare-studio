/**
 * TypeScript mirror of the CSS custom properties in tokens.css.
 *
 * Canvas and SVG renderers cannot read CSS variables cheaply inside their draw
 * loops, so the base palette is duplicated here as plain literals. The two
 * files are kept in sync by hand; tokens.sync.test.ts asserts they agree.
 */

/** Base color palette — mirrors the surface / border / text / accent vars. */
export const TOKENS = {
  surface0: '#0b0d11',
  surface1: '#101216',
  surface2: '#14161b',
  surface3: '#1d2027',
  surface4: '#242832',
  surfaceInset: '#11141a',

  border: '#2a2e37',
  borderStrong: '#000000',

  text1: '#e2e6ee',
  text2: '#c8cdd6',
  text3: '#8b93a3',
  text4: '#5b6270',

  accent: '#60a5fa',
  accentStrong: '#2453a8',

  danger: '#ef4444',
  dangerText: '#ffb4b4',
  dangerSurface: '#3b1219',
  warning: '#fbbf24',
  success: '#34d399',
  successStrong: '#22c55e',

  meterGreen: '#34d399',
  meterYellow: '#fbbf24',
  meterRed: '#ef4444',
  playhead: '#ff6e6e',
} as const;

/** Token key set, for the sync test. */
export type TokenName = keyof typeof TOKENS;

/**
 * Converts a `#rrggbb` color to an `rgba()` string with the given alpha.
 * Non-hex inputs are returned unchanged.
 *
 * @param color - CSS color string (expected `#rrggbb`).
 * @param alpha - Alpha in [0, 1].
 */
export function colorWithAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return color;
  const value = Number.parseInt(match[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
