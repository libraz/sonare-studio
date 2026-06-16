/**
 * Master-strip loudness readout helpers: derives the displayable true-peak
 * and phase-correlation values from a meter snapshot. Numeric formatting and
 * the clip-risk threshold are shared with the mastering preview
 * (src/ui/mastering/loudness.ts).
 */

import type { StereoMeterLevels } from '@/engine/meters';

/** Lowest correlation the meter bar represents (hard out-of-phase). */
export const CORRELATION_MIN = -1;

/** Highest correlation the meter bar represents (perfectly in phase). */
export const CORRELATION_MAX = 1;

/**
 * Maps a stereo correlation in [-1, 1] onto a 0..1 bar fraction (centred at
 * 0.5 for a decorrelated signal). Non-finite values map to the centre.
 *
 * @param correlation Stereo correlation reading.
 * @returns Fraction clamped to [0, 1].
 */
export function correlationFraction(correlation: number): number {
  if (!Number.isFinite(correlation)) return 0.5;
  const clamped = Math.min(CORRELATION_MAX, Math.max(CORRELATION_MIN, correlation));
  return (clamped - CORRELATION_MIN) / (CORRELATION_MAX - CORRELATION_MIN);
}

/**
 * Returns the louder of the two true-peak channels, ignoring channels the
 * engine did not report.
 *
 * @param levels Latest master meter levels.
 * @returns The max true peak in dBTP, or undefined when neither channel has a
 *   reading (lightweight lane/bus records carry no true-peak data).
 */
export function maxTruePeakDb(
  levels: Pick<StereoMeterLevels, 'truePeakDbL' | 'truePeakDbR'>,
): number | undefined {
  const { truePeakDbL, truePeakDbR } = levels;
  if (truePeakDbL === undefined) return truePeakDbR;
  if (truePeakDbR === undefined) return truePeakDbL;
  return Math.max(truePeakDbL, truePeakDbR);
}

/**
 * Difference between the integrated loudness and a target, in LU (loudness
 * units). Positive means louder than the target, negative quieter.
 *
 * @param integratedLufs Measured integrated loudness, when available.
 * @param targetLufs Target loudness in LUFS.
 * @returns The signed delta in LU, or undefined when no integrated reading
 *   exists (or it is still gating at negative infinity).
 */
export function loudnessDeltaLu(
  integratedLufs: number | undefined,
  targetLufs: number,
): number | undefined {
  if (integratedLufs === undefined || !Number.isFinite(integratedLufs)) return undefined;
  return integratedLufs - targetLufs;
}

/** Top of the gain-reduction bar scale in dB. */
export const GAIN_REDUCTION_BAR_MAX_DB = 12;

/** Gain reduction below this magnitude (dB) reads as "no reduction". */
export const GAIN_REDUCTION_EPSILON_DB = 0.1;

/**
 * Returns the active gain-reduction amount as a positive dB magnitude, or
 * undefined when there is effectively none. Dynamics processors only ever
 * attenuate, so the magnitude is the displayable reduction regardless of the
 * sign convention the engine reports it with.
 *
 * @param value Raw gainReductionDb reading (may be undefined / non-finite).
 * @returns Reduction magnitude in dB, or undefined below the epsilon.
 */
export function gainReductionAmountDb(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const magnitude = Math.abs(value);
  return magnitude >= GAIN_REDUCTION_EPSILON_DB ? magnitude : undefined;
}

/**
 * Maps a gain-reduction magnitude onto a 0..1 bar fraction over
 * [0, {@link GAIN_REDUCTION_BAR_MAX_DB}].
 *
 * @param amountDb Reduction magnitude in dB (>= 0).
 * @returns Fraction clamped to [0, 1].
 */
export function gainReductionFraction(amountDb: number): number {
  if (!Number.isFinite(amountDb) || amountDb <= 0) return 0;
  return Math.min(1, amountDb / GAIN_REDUCTION_BAR_MAX_DB);
}

/**
 * True when the snapshot carries the full loudness record (LUFS + true peak),
 * which only the master output target publishes. Lane and bus records omit
 * these fields, so the loudness readout stays hidden for them.
 *
 * @param levels Latest meter levels.
 * @returns True when momentary LUFS and at least one true-peak channel exist.
 */
export function hasLoudnessData(
  levels: Pick<StereoMeterLevels, 'momentaryLufs' | 'truePeakDbL' | 'truePeakDbR'>,
): boolean {
  return (
    levels.momentaryLufs !== undefined ||
    levels.truePeakDbL !== undefined ||
    levels.truePeakDbR !== undefined
  );
}
