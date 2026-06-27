/**
 * Decibel <-> linear-amplitude conversions shared across the mixer, engine
 * sync, exporter, sample editor and meters. Keeping one implementation avoids
 * the silence-floor drift that arises when the same `10 ** (db / 20)` /
 * `20 * log10` formulas are copied per call site.
 */

/**
 * Fader/measurement floor (in dB) standing in for a linear amplitude of 0.
 * Matches the meter bridge's silence floor so fader and meter readouts agree.
 */
export const SILENCE_DB = -120;

/**
 * Converts a decibel gain to a linear amplitude factor. Pure `10 ** (db / 20)`:
 * −∞ dB maps to 0 and a non-finite (NaN) input yields NaN, so callers that must
 * tolerate non-finite input should guard it (see {@link linearToDb}).
 *
 * @param db Gain in decibels (0 dB = unity).
 * @returns Linear amplitude factor (1 = unity).
 */
export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

/**
 * Converts a linear amplitude factor to decibels for fader values, clamped to
 * {@link SILENCE_DB} so a zero (or negative/non-finite) amplitude maps to the
 * silence floor rather than −∞.
 *
 * @param linear Linear amplitude (>= 0; 1 = unity).
 * @returns Gain in dB, never below {@link SILENCE_DB}.
 */
export function linearToDb(linear: number): number {
  if (!(linear > 0)) return SILENCE_DB;
  return Math.max(SILENCE_DB, 20 * Math.log10(linear));
}

/**
 * Converts a measured linear peak/level to decibels for metering and peak
 * readouts, returning −∞ at true silence (no floor clamp) so reports can
 * distinguish digital silence from a very low level.
 *
 * @param linear Measured linear amplitude (>= 0).
 * @returns Level in dBFS, or −∞ when the input is 0 (or non-positive).
 */
export function peakDb(linear: number): number {
  return linear > 0 ? 20 * Math.log10(linear) : Number.NEGATIVE_INFINITY;
}
