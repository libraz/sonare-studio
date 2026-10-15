/**
 * TypeScript mirror of the CSS custom properties in tokens.css.
 *
 * Canvas and SVG renderers cannot read CSS variables cheaply inside their draw
 * loops, so the base palette is duplicated here as plain literals. The two
 * files are kept in sync by hand; tests/theme-tokens.spec.ts asserts they agree.
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

  /* Metering chrome shared by every level meter and scope. The zone backdrops
   * are NOT listed: they are derived from the ramp above via colorWithAlpha so
   * two meters drawn by different components cannot drift apart. */
  meterWell: '#111418',
  meterPeakCool: '#4ade80',
  meterPeakWarm: '#facc15',
  meterPeakHot: '#f87171',
  meterHold: '#e5e7eb',
  meterClipOff: '#27272a',

  playhead: '#ff6e6e',
} as const;

/**
 * Opacity of the dimmed zone backdrop painted behind a meter bar, so the
 * green/yellow/red scale stays readable while the meter is silent.
 */
export const METER_ZONE_ALPHA = 0.12;

/**
 * Typeface the canvas editors label with, mirroring `--font-sans`.
 *
 * Canvas 2D takes a font shorthand string, not a CSS variable, so the stack is
 * duplicated here for the same reason the palette is. Without it the canvas
 * resolves a different family than the shell around it: the CSS stack asks for
 * the SF text face by name first, which is the intentional Apple-native choice
 * documented in tokens.css, and a bare `system-ui` does not.
 */
export const CANVAS_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", sans-serif';

/**
 * Canvas label sizes in px, mirroring the CSS scale steps the editors use.
 *
 * These track the root values only. A canvas draw loop does not observe the
 * compact-density attribute, so `xs` stays at its root 11px even where the
 * shell around it tightens to 10px; the chrome steps have no density override
 * to miss.
 */
export const CANVAS_FONT_SIZE_PX = {
  /** Meter scale numerals — `--fs-chrome-md`. */
  chromeMd: 8,
  /** Dense ruler ticks and clip captions — `--fs-2xs`. */
  meta: 10,
  /** Note labels inside the grid — `--fs-xs`. */
  label: 11,
} as const;

/**
 * Builds a canvas 2D `font` shorthand from the shared stack.
 *
 * @param sizePx Size in CSS pixels.
 * @param weight Optional numeric weight; omitted draws at the default weight.
 * @returns The `font` string to assign to a 2D context.
 */
export function canvasFont(sizePx: number, weight?: number): string {
  return weight === undefined
    ? `${sizePx}px ${CANVAS_FONT_STACK}`
    : `${weight} ${sizePx}px ${CANVAS_FONT_STACK}`;
}

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
