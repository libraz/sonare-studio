/**
 * Waveform peak (min/max per bucket) computation for clip rendering.
 *
 * Pure data module: no canvas, no DOM, no store access. The libsonare
 * waveformPeaks export is used when a module exposing it is passed in;
 * otherwise (or when the delegate fails) an equivalent pure-TS fallback runs.
 * Output shape is always exactly `bucketCount` buckets per channel, so the
 * arrangement renderer can map buckets to pixel columns directly.
 */

/** Min/max bucket pair for one channel (arrays of equal bucketCount length). */
export interface ChannelPeaks {
  /** Per-bucket minimum sample value (0 for empty buckets). */
  min: Float32Array;
  /** Per-bucket maximum sample value (0 for empty buckets). */
  max: Float32Array;
}

/** Report shape of the libsonare waveformPeaks export. */
export interface WaveformPeaksReportLike {
  min: Float32Array;
  max: Float32Array;
  channels: number;
  bucketCount: number;
  samplesPerBucket: number;
}

/** The subset of the libsonare module consumed by {@link computePeaks}. */
export interface WaveformPeaksModule {
  waveformPeaks?: (
    samples: Float32Array,
    channels: number,
    options?: { samplesPerBucket?: number; validate?: boolean },
  ) => WaveformPeaksReportLike;
}

/** Options for {@link computePeaks}. */
export interface ComputePeaksOptions {
  /**
   * Module exposing waveformPeaks (e.g. the initialized libsonare module) to
   * delegate the bucket scan to; omit or pass null for the pure-TS path.
   */
  wasm?: WaveformPeaksModule | null;
}

/** Interleaves planar channels for the wasm delegate (frame-major). */
function interleave(channels: ReadonlyArray<Float32Array>): Float32Array {
  const frames = channels[0]?.length ?? 0;
  const out = new Float32Array(frames * channels.length);
  for (let c = 0; c < channels.length; c++) {
    const channel = channels[c];
    for (let i = 0; i < frames; i++) {
      out[i * channels.length + c] = channel[i];
    }
  }
  return out;
}

/** Pure-TS min/max bucket scan with exactly bucketCount buckets. */
function computePeaksPure(
  channels: ReadonlyArray<Float32Array>,
  bucketCount: number,
): ChannelPeaks[] {
  return channels.map((channel) => {
    const frames = channel.length;
    const min = new Float32Array(bucketCount);
    const max = new Float32Array(bucketCount);
    for (let b = 0; b < bucketCount; b++) {
      const start = Math.floor((b * frames) / bucketCount);
      const end = Math.floor(((b + 1) * frames) / bucketCount);
      if (start >= end) continue; // empty bucket stays 0/0
      let lo = channel[start];
      let hi = channel[start];
      for (let i = start + 1; i < end; i++) {
        const v = channel[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[b] = lo;
      max[b] = hi;
    }
    return { min, max };
  });
}

/** Wasm-delegated bucket scan; returns null when unusable (then fall back). */
function computePeaksWasm(
  channels: ReadonlyArray<Float32Array>,
  bucketCount: number,
  mod: WaveformPeaksModule,
): ChannelPeaks[] | null {
  const fn = mod.waveformPeaks;
  if (typeof fn !== 'function') return null;
  const frames = channels[0]?.length ?? 0;
  if (frames === 0) return null;
  const samplesPerBucket = Math.max(1, Math.ceil(frames / bucketCount));
  let report: WaveformPeaksReportLike;
  try {
    report = fn(interleave(channels), channels.length, { samplesPerBucket, validate: false });
  } catch {
    return null;
  }
  if (
    !report ||
    report.channels !== channels.length ||
    !(report.min instanceof Float32Array) ||
    !(report.max instanceof Float32Array)
  ) {
    return null;
  }
  // The delegate derives its own bucket count from samplesPerBucket; pad or
  // trim each channel-major slice to exactly bucketCount buckets.
  const copied = Math.min(bucketCount, report.bucketCount);
  return channels.map((_, c) => {
    const min = new Float32Array(bucketCount);
    const max = new Float32Array(bucketCount);
    const offset = c * report.bucketCount;
    min.set(report.min.subarray(offset, offset + copied));
    max.set(report.max.subarray(offset, offset + copied));
    return { min, max };
  });
}

/**
 * Computes per-channel min/max waveform buckets.
 *
 * @param channels Planar channel buffers (equal lengths expected).
 * @param bucketCount Number of buckets per channel (positive integer).
 * @param options Optional wasm delegate.
 * @returns One {@link ChannelPeaks} per input channel.
 */
export function computePeaks(
  channels: ReadonlyArray<Float32Array>,
  bucketCount: number,
  options: ComputePeaksOptions = {},
): ChannelPeaks[] {
  if (!Number.isInteger(bucketCount) || bucketCount < 1) {
    throw new RangeError(`bucketCount must be a positive integer, got ${bucketCount}`);
  }
  if (channels.length === 0) return [];
  if (options.wasm) {
    const delegated = computePeaksWasm(channels, bucketCount, options.wasm);
    if (delegated) return delegated;
  }
  return computePeaksPure(channels, bucketCount);
}

/**
 * Merges per-channel peaks into one envelope (bucket-wise min of mins and
 * max of maxes), e.g. for a single-lane clip waveform.
 *
 * @param peaks Per-channel peaks of equal bucket counts.
 * @returns The merged peaks (zero-length arrays for empty input).
 */
export function mergePeaks(peaks: ReadonlyArray<ChannelPeaks>): ChannelPeaks {
  if (peaks.length === 0) return { min: new Float32Array(0), max: new Float32Array(0) };
  const bucketCount = peaks[0].min.length;
  for (const p of peaks) {
    if (p.min.length !== bucketCount || p.max.length !== bucketCount) {
      throw new RangeError('mergePeaks requires equal bucket counts on all channels');
    }
  }
  const min = new Float32Array(peaks[0].min);
  const max = new Float32Array(peaks[0].max);
  for (let c = 1; c < peaks.length; c++) {
    for (let b = 0; b < bucketCount; b++) {
      if (peaks[c].min[b] < min[b]) min[b] = peaks[c].min[b];
      if (peaks[c].max[b] > max[b]) max[b] = peaks[c].max[b];
    }
  }
  return { min, max };
}

/**
 * Caches computed peaks per (assetId, bucketCount): the arrangement renderer
 * asks for the same zoom levels over and over while scrolling. Entries must
 * be invalidated when an asset's audio changes (asset ids are content-hashed
 * by default, so replacement normally means a new id anyway).
 */
export class WaveformPeaksCache {
  private readonly cache = new Map<string, ChannelPeaks[]>();
  private readonly options: ComputePeaksOptions;

  constructor(options: ComputePeaksOptions = {}) {
    this.options = options;
  }

  /**
   * Returns the cached peaks for an asset at one zoom level, computing them
   * on miss. Treat the result as immutable (it is shared across callers).
   *
   * @param assetId Asset id the channels belong to (cache key component).
   * @param channels Planar channel buffers of the asset.
   * @param bucketCount Number of buckets (zoom level; cache key component).
   */
  get(assetId: string, channels: ReadonlyArray<Float32Array>, bucketCount: number): ChannelPeaks[] {
    const key = `${assetId}|${bucketCount}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const computed = computePeaks(channels, bucketCount, this.options);
    this.cache.set(key, computed);
    return computed;
  }

  /**
   * Like {@link get}, but merged across channels into one envelope.
   * Merged results are cached separately per zoom level.
   */
  getMerged(
    assetId: string,
    channels: ReadonlyArray<Float32Array>,
    bucketCount: number,
  ): ChannelPeaks {
    const key = `${assetId}|${bucketCount}|merged`;
    const cached = this.cache.get(key);
    if (cached) return cached[0];
    const merged = mergePeaks(this.get(assetId, channels, bucketCount));
    this.cache.set(key, [merged]);
    return merged;
  }

  /** Drops all cached zoom levels of one asset. */
  invalidate(assetId: string): void {
    const prefix = `${assetId}|`;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /** Drops the whole cache. */
  clear(): void {
    this.cache.clear();
  }
}

/** Builds a {@link WaveformPeaksCache} (optionally with a wasm delegate). */
export function createWaveformPeaksCache(options: ComputePeaksOptions = {}): WaveformPeaksCache {
  return new WaveformPeaksCache(options);
}
