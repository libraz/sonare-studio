/**
 * Loudness readout helpers for the mastering preview: numeric formatting,
 * bar-meter fractions and the true-peak clip warning threshold.
 */

/** True-peak levels above this (dBTP) are flagged as a clipping risk. */
export const CLIP_WARN_TRUE_PEAK_DB = -0.3;

/** Bottom of the loudness bar scale in dB. */
export const LOUDNESS_BAR_MIN_DB = -60;

/**
 * Maps a dB value onto a 0..1 bar fraction over [minDb, maxDb].
 * Non-finite values (silence) map to 0.
 *
 * @param valueDb The level in dB (or LUFS).
 * @param minDb Bottom of the scale (default {@link LOUDNESS_BAR_MIN_DB}).
 * @param maxDb Top of the scale (default 0).
 * @returns Fraction clamped to [0, 1].
 */
export function loudnessBarFraction(
  valueDb: number | undefined,
  minDb: number = LOUDNESS_BAR_MIN_DB,
  maxDb = 0,
): number {
  if (valueDb === undefined || !Number.isFinite(valueDb) || maxDb <= minDb) return 0;
  return Math.min(1, Math.max(0, (valueDb - minDb) / (maxDb - minDb)));
}

/**
 * Formats a dB (or LUFS) value for the readout: one decimal, '-∞' for
 * negative infinity, an em dash when unavailable.
 *
 * @param value The level, or undefined when the metering one-shot is absent.
 * @param digits Decimal places (default 1).
 * @returns Display text without a unit suffix.
 */
export function formatLevel(value: number | undefined, digits = 1): string {
  if (value === undefined || Number.isNaN(value)) return '—';
  if (value === Number.NEGATIVE_INFINITY) return '-∞';
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

/**
 * True when a true-peak reading exceeds the clip warning threshold.
 *
 * @param truePeakDb Measured true peak in dBTP, when available.
 * @returns True for readings above {@link CLIP_WARN_TRUE_PEAK_DB}.
 */
export function isClippingRisk(truePeakDb: number | undefined): boolean {
  return truePeakDb !== undefined && Number.isFinite(truePeakDb)
    ? truePeakDb > CLIP_WARN_TRUE_PEAK_DB
    : false;
}
