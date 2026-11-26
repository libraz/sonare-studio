import { clamp } from '@/lib/math';
import { SILENCE_TEXT } from '@/ui/mixer/db-scale';
/**
 * Loudness readout helpers for the mastering preview: numeric formatting,
 * bar-meter fractions and the true-peak clip warning threshold.
 */

/** True-peak levels above this (dBTP) are flagged as a clipping risk. */
export const CLIP_WARN_TRUE_PEAK_DB = -0.3;

/** Bottom of the loudness bar scale in dB. */
export const LOUDNESS_BAR_MIN_DB = -60;
/** Useful upper bound for LRA and dynamic-range comparison bars. */
export const RANGE_BAR_MAX_DB = 20;

/** One A/B loudness readout row and the scale used by its comparison bars. */
export interface LoudnessRow {
  label: string;
  /** What an abbreviated label measures; empty when the label says it. */
  hint?: string;
  unit: string;
  a: number | undefined;
  b: number | undefined;
  /** Level rows use dB/LUFS scaling; range rows use a positive range scale. */
  barScale: 'level' | 'range';
}

/**
 * Maps a dB value onto a 0..1 bar fraction over [minDb, maxDb].
 * Negative infinity (silence) maps to 0; positive infinity saturates at 1.
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
  if (valueDb === undefined || Number.isNaN(valueDb) || maxDb <= minDb) return 0;
  return clamp((valueDb - minDb) / (maxDb - minDb), 0, 1);
}

/**
 * Maps a non-negative variation metric (LRA or dynamic range) to a comparison
 * bar. These metrics are not dBFS levels, so treating zero as the top of a
 * level meter made every positive reading appear full scale.
 */
export function rangeBarFraction(value: number | undefined, max = RANGE_BAR_MAX_DB): number {
  if (value === undefined || Number.isNaN(value) || max <= 0) return 0;
  return clamp(value / max, 0, 1);
}

/**
 * Formats a dB (or LUFS) value for the readout: one decimal, {@link SILENCE_TEXT} for
 * negative infinity, an em dash when unavailable.
 *
 * @param value The level, or undefined when the metering one-shot is absent.
 * @param digits Decimal places (default 1).
 * @returns Display text without a unit suffix.
 */
export function formatLevel(value: number | undefined, digits = 1): string {
  if (value === undefined || Number.isNaN(value)) return '—';
  if (value === Number.NEGATIVE_INFINITY) return SILENCE_TEXT;
  if (value === Number.POSITIVE_INFINITY) return '∞';
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
  return truePeakDb !== undefined && truePeakDb > CLIP_WARN_TRUE_PEAK_DB;
}
