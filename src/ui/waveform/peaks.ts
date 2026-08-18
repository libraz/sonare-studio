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

/**
 * Reduces one bucket run onto exactly `outCount` buckets, proportionally.
 *
 * Both the wasm delegate and a previously computed zoom level hand back a
 * bucket grid that is finer than the one being asked for but rarely a whole
 * multiple of it. Each output bucket therefore takes the min/max across the
 * input buckets its span covers, which keeps every sample of the source in the
 * envelope. Taking a prefix instead would drop the tail of the asset and
 * stretch everything before it across the full clip width.
 *
 * @param min Source minima (channel-major).
 * @param max Source maxima (channel-major).
 * @param offset Index of this channel's first bucket.
 * @param inCount Buckets per channel in the source (must be >= outCount).
 * @param outCount Buckets to produce.
 */
function reduceBuckets(
  min: Float32Array,
  max: Float32Array,
  offset: number,
  inCount: number,
  outCount: number,
): ChannelPeaks {
  const outMin = new Float32Array(outCount);
  const outMax = new Float32Array(outCount);
  for (let b = 0; b < outCount; b++) {
    const start = Math.floor((b * inCount) / outCount);
    const end = Math.max(start + 1, Math.floor(((b + 1) * inCount) / outCount));
    let lo = min[offset + start];
    let hi = max[offset + start];
    for (let i = start + 1; i < end; i++) {
      const v = min[offset + i];
      const w = max[offset + i];
      if (v < lo) lo = v;
      if (w > hi) hi = w;
    }
    outMin[b] = lo;
    outMax[b] = hi;
  }
  return { min: outMin, max: outMax };
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
  // The delegate derives bucket count by ceil(frames / samplesPerBucket). A
  // floor keeps that count at or above our requested resolution; when audio is
  // sparser than pixels, skip the delegate before allocating an interleaved
  // copy because it cannot supply every bucket anyway.
  if (frames < bucketCount) return null;
  const samplesPerBucket = Math.max(1, Math.floor(frames / bucketCount));
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
  // The delegate derives its own bucket count from an integer samplesPerBucket
  // and so overshoots the request; reduce each channel-major slice onto exactly
  // bucketCount buckets. A shorter report would leave the right edge blank, so
  // use the pure path instead.
  if (report.bucketCount < bucketCount) return null;
  return channels.map((_, c) =>
    reduceBuckets(report.min, report.max, c * report.bucketCount, report.bucketCount, bucketCount),
  );
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
  /** Bucket counts held per asset, so a coarser level can reuse a finer one. */
  private readonly levels = new Map<string, Set<number>>();
  private readonly options: ComputePeaksOptions;

  constructor(options: ComputePeaksOptions = {}) {
    this.options = options;
  }

  /** Finest cached level of an asset that can be reduced onto `bucketCount`. */
  private finerLevel(assetId: string, bucketCount: number): number | null {
    let best: number | null = null;
    for (const level of this.levels.get(assetId) ?? []) {
      if (level > bucketCount && (best === null || level < best)) best = level;
    }
    return best;
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
    // Zooming out asks for a coarser envelope of audio already scanned once.
    // Reducing the finer level costs one pass over its buckets instead of
    // another pass over every sample of the asset.
    const finer = this.finerLevel(assetId, bucketCount);
    const source = finer === null ? null : this.cache.get(`${assetId}|${finer}`);
    const computed =
      source && finer !== null
        ? source.map((channel) => reduceBuckets(channel.min, channel.max, 0, finer, bucketCount))
        : computePeaks(channels, bucketCount, this.options);
    this.cache.set(key, computed);
    (this.levels.get(assetId) ?? this.levels.set(assetId, new Set()).get(assetId)!).add(
      bucketCount,
    );
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
    this.levels.delete(assetId);
  }

  /** Drops the whole cache. */
  clear(): void {
    this.cache.clear();
    this.levels.clear();
  }
}

/** Builds a {@link WaveformPeaksCache} (optionally with a wasm delegate). */
export function createWaveformPeaksCache(options: ComputePeaksOptions = {}): WaveformPeaksCache {
  return new WaveformPeaksCache(options);
}
