/**
 * Scale and formatting math for the mixer UI.
 *
 * The fader maps a normalized position in [0, 1] to decibels through a
 * piecewise-linear taper that concentrates travel around unity gain (0 dB
 * sits at 3/4 of the throw), like hardware console faders. The taper is
 * monotonic, so position<->dB conversions round-trip exactly within float
 * precision.
 */

/** Bottom of the fader throw in dB (rendered as -inf). */
export const FADER_MIN_DB = -96;

/** Top of the fader throw in dB. */
export const FADER_MAX_DB = 24;

/** Default fader throw in px; the strip meter beside it matches. */
export const FADER_HEIGHT = 132;

/** Gain at or below this many dB is displayed as -inf. */
export const SILENCE_DISPLAY_DB = -90;

/**
 * Fader taper anchor points as [position, dB] pairs, ascending in both
 * coordinates; segments are interpolated linearly.
 */
const FADER_TAPER: ReadonlyArray<readonly [number, number]> = [
  [0, FADER_MIN_DB],
  [0.06, -60],
  [0.18, -42],
  [0.36, -24],
  [0.54, -12],
  [0.75, 0],
  [1, FADER_MAX_DB],
];

/** Clamps a number to [lo, hi]. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Converts a normalized fader position to decibels.
 *
 * @param position Fader position in [0, 1] (0 = bottom); clamped.
 * @returns Gain in dB within [FADER_MIN_DB, FADER_MAX_DB].
 */
export function faderPositionToDb(position: number): number {
  const p = clamp(position, 0, 1);
  for (let i = 1; i < FADER_TAPER.length; i++) {
    const [p0, db0] = FADER_TAPER[i - 1];
    const [p1, db1] = FADER_TAPER[i];
    if (p <= p1) {
      return db0 + ((p - p0) / (p1 - p0)) * (db1 - db0);
    }
  }
  return FADER_MAX_DB;
}

/**
 * Converts decibels to a normalized fader position (inverse of
 * {@link faderPositionToDb}).
 *
 * @param db Gain in dB; clamped to the fader range.
 * @returns Position in [0, 1].
 */
export function dbToFaderPosition(db: number): number {
  const d = clamp(db, FADER_MIN_DB, FADER_MAX_DB);
  for (let i = 1; i < FADER_TAPER.length; i++) {
    const [p0, db0] = FADER_TAPER[i - 1];
    const [p1, db1] = FADER_TAPER[i];
    if (d <= db1) {
      return p0 + ((d - db0) / (db1 - db0)) * (p1 - p0);
    }
  }
  return 1;
}

/**
 * Formats a dB value for display: explicit sign for boosts, one decimal,
 * '-inf' at or below the silence floor.
 *
 * @param db Gain in dB.
 * @param fractionDigits Decimal places (default 1).
 */
export function formatDb(db: number, fractionDigits = 1): string {
  if (db <= SILENCE_DISPLAY_DB) return '-inf';
  const text = Math.abs(db).toFixed(fractionDigits);
  // Avoid '-0.0' for tiny negative values that round to zero.
  if (Number(text) === 0) return (0).toFixed(fractionDigits);
  return db < 0 ? `-${text}` : `+${text}`;
}

/**
 * Formats a balance value: 'C' centered, otherwise 'L'/'R' plus percentage.
 *
 * @param pan Balance in [-1, 1].
 */
export function formatPan(pan: number): string {
  const percent = Math.round(Math.abs(clamp(pan, -1, 1)) * 100);
  if (percent === 0) return 'C';
  return pan < 0 ? `L${percent}` : `R${percent}`;
}

/**
 * Formats a frequency for compact display: '250', '1.2k', '12k'.
 *
 * @param hz Frequency in Hz.
 */
export function formatHz(hz: number): string {
  if (hz >= 10000) return `${Math.round(hz / 1000)}k`;
  if (hz >= 1000) return `${(hz / 1000).toFixed(1)}k`;
  return `${Math.round(hz)}`;
}
