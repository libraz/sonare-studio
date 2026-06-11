/**
 * Waveform rendering and trim-bound math for audio clips on the arrangement
 * canvas: peak pyramid level selection from the horizontal zoom, mapping of a
 * clip's source window onto peak buckets, and source bounds for trim
 * clamping. Pure logic: no DOM, no store access, no IO.
 *
 * PPQ <-> seconds conversions assume a constant tempo, matching the playback
 * scheduling layer's limitation.
 */

/** Per-bucket min/max envelope as produced by the waveform peaks module. */
export interface PeakEnvelope {
  /** Per-bucket minimum sample value. */
  min: Float32Array;
  /** Per-bucket maximum sample value. */
  max: Float32Array;
}

/**
 * Peak pyramid levels in buckets per second of source audio, coarsest first.
 * The renderer picks the smallest level that still gives at least one bucket
 * per pixel column, so zooming cycles through a handful of cached
 * resolutions instead of recomputing peaks for every pixel width.
 */
export const PEAK_BUCKETS_PER_SECOND_LEVELS: readonly number[] = [4, 16, 64, 256, 1024];

/**
 * Picks the peak pyramid level for a horizontal zoom.
 *
 * @param pxPerSecond - Pixels covered by one second of source audio.
 * @returns The smallest level (buckets per second) at or above the zoom, or
 *   the finest level when the zoom exceeds all levels.
 */
export function peaksBucketsPerSecond(pxPerSecond: number): number {
  for (const level of PEAK_BUCKETS_PER_SECOND_LEVELS) {
    if (level >= pxPerSecond) return level;
  }
  return PEAK_BUCKETS_PER_SECOND_LEVELS[PEAK_BUCKETS_PER_SECOND_LEVELS.length - 1];
}

/**
 * Computes the bucket count of a peak envelope covering a whole asset at one
 * pyramid level. At least 1, and never more buckets than frames.
 *
 * @param numFrames - Total frames of the asset (>= 0).
 * @param sampleRate - Asset sample rate in Hz (> 0).
 * @param bucketsPerSecond - Pyramid level from {@link peaksBucketsPerSecond}.
 * @returns Bucket count for the asset at that level.
 */
export function peaksBucketCount(
  numFrames: number,
  sampleRate: number,
  bucketsPerSecond: number,
): number {
  if (!(numFrames > 0) || !(sampleRate > 0) || !(bucketsPerSecond > 0)) return 1;
  const buckets = Math.ceil((numFrames / sampleRate) * bucketsPerSecond);
  return Math.max(1, Math.min(buckets, numFrames));
}

/**
 * Length of an audio asset in PPQ at a constant tempo.
 *
 * @param numFrames - Total frames of the asset.
 * @param sampleRate - Asset sample rate in Hz (> 0).
 * @param tempoBpm - Constant tempo in BPM (> 0).
 * @returns Asset duration in quarter-note PPQ (0 for degenerate inputs).
 */
export function assetLengthPpq(numFrames: number, sampleRate: number, tempoBpm: number): number {
  if (!(numFrames > 0) || !(sampleRate > 0) || !(tempoBpm > 0)) return 0;
  return (numFrames / sampleRate) * (tempoBpm / 60);
}

/** A clip's source window as fractions of the backing asset duration. */
export interface AudioWindowFractions {
  /** Window start as a fraction of the asset duration (may exceed [0, 1]). */
  startFrac: number;
  /** Window end as a fraction of the asset duration (may exceed [0, 1]). */
  endFrac: number;
}

/**
 * Maps a clip's audible source window onto the backing asset as duration
 * fractions. The result is intentionally not clamped: the part of the window
 * past the asset end maps to fractions > 1 and renders as silence.
 *
 * @param sourceOffsetPpq - Window offset into the source, in PPQ.
 * @param lengthPpq - Window length in PPQ.
 * @param tempoBpm - Constant tempo in BPM (> 0).
 * @param numFrames - Total frames of the asset (> 0).
 * @param sampleRate - Asset sample rate in Hz (> 0).
 * @returns Start/end fractions, or a degenerate zero window for bad inputs.
 */
export function audioWindowFractions(
  sourceOffsetPpq: number,
  lengthPpq: number,
  tempoBpm: number,
  numFrames: number,
  sampleRate: number,
): AudioWindowFractions {
  const durationPpq = assetLengthPpq(numFrames, sampleRate, tempoBpm);
  if (!(durationPpq > 0) || !(lengthPpq > 0)) return { startFrac: 0, endFrac: 0 };
  return {
    startFrac: sourceOffsetPpq / durationPpq,
    endFrac: (sourceOffsetPpq + lengthPpq) / durationPpq,
  };
}

/** One pixel column of a clip waveform (sample values in [-1, 1] space). */
export interface WaveformColumn {
  /** Column minimum sample value (0 when the column maps outside the asset). */
  min: number;
  /** Column maximum sample value (0 when the column maps outside the asset). */
  max: number;
}

/**
 * Maps a source window of a peak envelope onto fixed pixel columns. Each
 * column aggregates the min/max of every bucket it overlaps; columns mapping
 * entirely outside the asset ([0, 1) fraction range) come back as 0/0 so
 * trimmed-past-the-end regions render flat.
 *
 * @param peaks - Whole-asset peak envelope (bucket 0 = asset start).
 * @param startFrac - Window start as a fraction of the asset duration.
 * @param endFrac - Window end as a fraction of the asset duration.
 * @param columnCount - Number of pixel columns (>= 1).
 * @returns One column per pixel, or an empty array for degenerate input.
 */
export function waveformColumns(
  peaks: PeakEnvelope,
  startFrac: number,
  endFrac: number,
  columnCount: number,
): WaveformColumn[] {
  const bucketCount = peaks.min.length;
  if (!(columnCount >= 1) || !(endFrac > startFrac) || bucketCount === 0) return [];
  const columns: WaveformColumn[] = new Array(columnCount);
  const span = endFrac - startFrac;
  for (let j = 0; j < columnCount; j++) {
    const f0 = startFrac + (j / columnCount) * span;
    const f1 = startFrac + ((j + 1) / columnCount) * span;
    if (f1 <= 0 || f0 >= 1) {
      columns[j] = { min: 0, max: 0 };
      continue;
    }
    let b0 = Math.max(0, Math.floor(f0 * bucketCount));
    let b1 = Math.min(bucketCount, Math.ceil(f1 * bucketCount));
    if (b1 <= b0) {
      // Sub-bucket column: sample the bucket under the column start.
      b0 = Math.min(bucketCount - 1, b0);
      b1 = b0 + 1;
    }
    let lo = peaks.min[b0];
    let hi = peaks.max[b0];
    for (let b = b0 + 1; b < b1; b++) {
      if (peaks.min[b] < lo) lo = peaks.min[b];
      if (peaks.max[b] > hi) hi = peaks.max[b];
    }
    columns[j] = { min: lo, max: hi };
  }
  return columns;
}

/** Timeline bounds a non-looping audio clip's trims must stay inside. */
export interface AudioClipSourceBounds {
  /** Lowest allowed clip start in PPQ (source offset cannot go negative). */
  minStartPpq: number;
  /** Highest allowed clip end in PPQ (window cannot pass the asset end). */
  maxEndPpq: number;
}

/**
 * Computes the trim bounds of an audio clip against its backing asset: the
 * start edge cannot move left of source offset 0 and the end edge cannot
 * extend the window past the asset length (no looping for audio playback).
 *
 * @param clip - Current clip timeline position and source offset.
 * @param assetPpq - Asset length in PPQ (see {@link assetLengthPpq}).
 * @returns The clamping bounds in timeline PPQ.
 */
export function audioClipSourceBounds(
  clip: { startPpq: number; sourceOffsetPpq: number },
  assetPpq: number,
): AudioClipSourceBounds {
  const sourceStartPpq = clip.startPpq - clip.sourceOffsetPpq;
  return {
    minStartPpq: Math.max(0, sourceStartPpq),
    maxEndPpq: sourceStartPpq + assetPpq,
  };
}
