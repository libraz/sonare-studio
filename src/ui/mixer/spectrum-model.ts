/**
 * Pure helpers for the master spectrum analyzer and goniometer (vectorscope).
 *
 * These displays can be fed either from per-target realtime scope telemetry or
 * from a Web Audio `AnalyserNode` tap on the engine output. This module holds
 * the unit-testable maths that map raw analyser data onto canvas coordinates:
 * log-frequency placement, dB scaling, FFT bin frequencies, and the rotated
 * goniometer projection.
 */

/** Lowest frequency the spectrum display spans, in Hz. */
export const SPECTRUM_MIN_FREQ = 20;

/** Highest frequency the spectrum display spans, in Hz. */
export const SPECTRUM_MAX_FREQ = 20000;

/** Bottom of the spectrum magnitude scale, in dBFS. */
export const SPECTRUM_MIN_DB = -100;

/** Top of the spectrum magnitude scale, in dBFS. */
export const SPECTRUM_MAX_DB = 0;

/**
 * Maps a frequency onto a 0..1 horizontal fraction using a log scale, so each
 * octave occupies equal width. Values outside the display range clamp to the
 * edges; non-finite or non-positive inputs map to 0.
 *
 * @param freq Frequency in Hz.
 * @param minFreq Left-edge frequency (default {@link SPECTRUM_MIN_FREQ}).
 * @param maxFreq Right-edge frequency (default {@link SPECTRUM_MAX_FREQ}).
 * @returns Fraction clamped to [0, 1].
 */
export function frequencyToFraction(
  freq: number,
  minFreq: number = SPECTRUM_MIN_FREQ,
  maxFreq: number = SPECTRUM_MAX_FREQ,
): number {
  if (!Number.isFinite(freq) || freq <= 0) return 0;
  const span = Math.log(maxFreq / minFreq);
  if (span <= 0) return 0;
  const frac = Math.log(freq / minFreq) / span;
  return Math.min(1, Math.max(0, frac));
}

/**
 * Maps a magnitude in dBFS onto a 0..1 vertical fraction where 1 is the top of
 * the scale ({@link SPECTRUM_MAX_DB}) and 0 the bottom ({@link SPECTRUM_MIN_DB}).
 * Non-finite values (silence is reported as -Infinity) map to 0.
 *
 * @param db Magnitude in dBFS.
 * @param minDb Bottom of the scale (default {@link SPECTRUM_MIN_DB}).
 * @param maxDb Top of the scale (default {@link SPECTRUM_MAX_DB}).
 * @returns Fraction clamped to [0, 1].
 */
export function spectrumDbToFraction(
  db: number,
  minDb: number = SPECTRUM_MIN_DB,
  maxDb: number = SPECTRUM_MAX_DB,
): number {
  if (!Number.isFinite(db)) return 0;
  const span = maxDb - minDb;
  if (span <= 0) return 0;
  const frac = (db - minDb) / span;
  return Math.min(1, Math.max(0, frac));
}

/**
 * Centre frequency of an FFT bin for a given transform size and sample rate.
 *
 * @param binIndex Bin index (0 is DC).
 * @param sampleRate Audio sample rate in Hz.
 * @param fftSize FFT window length (twice the bin count).
 * @returns Bin centre frequency in Hz.
 */
export function binFrequency(binIndex: number, sampleRate: number, fftSize: number): number {
  if (fftSize <= 0) return 0;
  return (binIndex * sampleRate) / fftSize;
}

/** A point in the goniometer's rotated (mid/side) coordinate space. */
export interface GoniometerXY {
  /** Horizontal axis: stereo side content, in roughly [-1, 1]. */
  x: number;
  /** Vertical axis: stereo mid content, in roughly [-1, 1] (up is in-phase). */
  y: number;
}

/**
 * Projects a stereo sample pair onto goniometer coordinates rotated 45°, so a
 * mono (in-phase) signal traces the vertical axis and a fully out-of-phase
 * signal the horizontal one. The scale matches a classic ±1 full-scale display:
 * a hard-panned full-scale channel reaches |x| = |y| = 1/√2.
 *
 * @param left Left-channel sample in [-1, 1].
 * @param right Right-channel sample in [-1, 1].
 * @returns The rotated coordinate; `y` points up for in-phase content.
 */
export function goniometerXY(left: number, right: number): GoniometerXY {
  return {
    x: (left - right) * Math.SQRT1_2,
    y: (left + right) * Math.SQRT1_2,
  };
}
