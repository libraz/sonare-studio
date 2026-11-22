/**
 * Pure offline sample-editing operations for the sample editor.
 *
 * Every function takes planar channel buffers plus an optional frame range
 * and returns NEW buffers — inputs are never mutated, so callers can hand in
 * cached (shared) asset audio directly. When no range is given an operation
 * applies to the whole file. Ranges are clamped to the buffer bounds.
 */

import { dbToLinear } from '@/lib/db';
import { clamp } from '@/lib/math';

/** A half-open frame range over planar audio buffers. */
export interface SampleRange {
  /** First frame of the range (inclusive). */
  startFrame: number;
  /** End frame of the range (exclusive). */
  endFrame: number;
}

/** Returns the frame count of planar channels (0 for no channels). */
export function frameCount(channels: ReadonlyArray<Float32Array>): number {
  return channels[0]?.length ?? 0;
}

/** Throws unless all channels have the same length. */
function assertPlanar(channels: ReadonlyArray<Float32Array>): void {
  const frames = frameCount(channels);
  for (const channel of channels) {
    if (channel.length !== frames) {
      throw new RangeError('All channels must have the same length');
    }
  }
}

/**
 * Clamps a range into [0, totalFrames], flooring fractional frame indices.
 * A reversed range collapses to an empty range at its (clamped) start.
 */
export function clampRange(range: SampleRange, totalFrames: number): SampleRange {
  const startFrame = clamp(Math.floor(range.startFrame), 0, totalFrames);
  const endFrame = clamp(Math.floor(range.endFrame), startFrame, totalFrames);
  return { startFrame, endFrame };
}

/**
 * Resolves the effective operation range: the clamped given range, or the
 * whole file when none is given.
 */
export function resolveRange(
  channels: ReadonlyArray<Float32Array>,
  range?: SampleRange | null,
): SampleRange {
  const frames = frameCount(channels);
  if (!range) return { startFrame: 0, endFrame: frames };
  return clampRange(range, frames);
}

/** Copies every channel (the shared starting point of all in-range edits). */
function copyChannels(channels: ReadonlyArray<Float32Array>): Float32Array[] {
  return channels.map((channel) => new Float32Array(channel));
}

/**
 * Returns the maximum absolute sample value across all channels inside the
 * range (whole file when omitted).
 */
export function peakAmplitude(
  channels: ReadonlyArray<Float32Array>,
  range?: SampleRange | null,
): number {
  assertPlanar(channels);
  const { startFrame, endFrame } = resolveRange(channels, range);
  let peak = 0;
  for (const channel of channels) {
    for (let i = startFrame; i < endFrame; i++) {
      const value = Math.abs(channel[i]);
      if (value > peak) peak = value;
    }
  }
  return peak;
}

/**
 * Applies a decibel gain to the range (whole file when omitted).
 *
 * @param channels Planar channel buffers (not mutated).
 * @param gainDb Gain in decibels (finite; positive boosts, negative cuts).
 * @param range Optional frame range.
 * @returns New channel buffers with the gain applied inside the range.
 */
export function applyGainDb(
  channels: ReadonlyArray<Float32Array>,
  gainDb: number,
  range?: SampleRange | null,
): Float32Array[] {
  if (!Number.isFinite(gainDb)) {
    throw new RangeError(`gainDb must be finite, got ${gainDb}`);
  }
  assertPlanar(channels);
  const { startFrame, endFrame } = resolveRange(channels, range);
  const gain = dbToLinear(gainDb);
  const out = copyChannels(channels);
  for (const channel of out) {
    for (let i = startFrame; i < endFrame; i++) channel[i] *= gain;
  }
  return out;
}

/** Applies gain in place to channel buffers owned by a worker. */
export function applyGainDbInPlace(
  channels: Float32Array[],
  gainDb: number,
  range?: SampleRange | null,
): Float32Array[] {
  if (!Number.isFinite(gainDb)) {
    throw new RangeError(`gainDb must be finite, got ${gainDb}`);
  }
  assertPlanar(channels);
  const { startFrame, endFrame } = resolveRange(channels, range);
  const gain = dbToLinear(gainDb);
  for (const channel of channels) {
    for (let i = startFrame; i < endFrame; i++) channel[i] *= gain;
  }
  return channels;
}

/**
 * Scales the range so its peak hits the target level. The scale factor is
 * shared across channels (the stereo image is preserved) and both the peak
 * measurement and the scaling are limited to the range. Silent ranges are
 * returned unchanged.
 *
 * @param channels Planar channel buffers (not mutated).
 * @param targetDb Target peak level in dBFS (finite, typically <= 0).
 * @param range Optional frame range.
 * @returns New channel buffers normalized inside the range.
 */
export function normalizeToDb(
  channels: ReadonlyArray<Float32Array>,
  targetDb: number,
  range?: SampleRange | null,
): Float32Array[] {
  if (!Number.isFinite(targetDb)) {
    throw new RangeError(`targetDb must be finite, got ${targetDb}`);
  }
  assertPlanar(channels);
  const resolved = resolveRange(channels, range);
  const peak = peakAmplitude(channels, resolved);
  const out = copyChannels(channels);
  if (peak === 0) return out;
  const gain = dbToLinear(targetDb) / peak;
  for (const channel of out) {
    for (let i = resolved.startFrame; i < resolved.endFrame; i++) channel[i] *= gain;
  }
  return out;
}

/** Normalizes in place to channel buffers owned by a worker. */
export function normalizeToDbInPlace(
  channels: Float32Array[],
  targetDb: number,
  range?: SampleRange | null,
): Float32Array[] {
  if (!Number.isFinite(targetDb)) {
    throw new RangeError(`targetDb must be finite, got ${targetDb}`);
  }
  assertPlanar(channels);
  const resolved = resolveRange(channels, range);
  const peak = peakAmplitude(channels, resolved);
  if (peak === 0) return channels;
  const gain = dbToLinear(targetDb) / peak;
  for (const channel of channels) {
    for (let i = resolved.startFrame; i < resolved.endFrame; i++) channel[i] *= gain;
  }
  return channels;
}

/** Ramp multiplier at frame i of an n-frame linear fade-in (0 at i=0). */
function fadeInMultiplier(i: number, n: number): number {
  return n <= 1 ? 0 : i / (n - 1);
}

/** Ramp multiplier at frame i of an n-frame linear fade-out (0 at the end). */
function fadeOutMultiplier(i: number, n: number): number {
  return n <= 1 ? 0 : 1 - i / (n - 1);
}

/**
 * Applies a linear fade-in across the range (whole file when omitted): the
 * first frame becomes silent and the last frame keeps its original level.
 */
export function fadeInLinear(
  channels: ReadonlyArray<Float32Array>,
  range?: SampleRange | null,
): Float32Array[] {
  assertPlanar(channels);
  const { startFrame, endFrame } = resolveRange(channels, range);
  const n = endFrame - startFrame;
  const out = copyChannels(channels);
  for (const channel of out) {
    for (let i = 0; i < n; i++) channel[startFrame + i] *= fadeInMultiplier(i, n);
  }
  return out;
}

/** Applies a fade-in in place to channel buffers owned by a worker. */
export function fadeInLinearInPlace(
  channels: Float32Array[],
  range?: SampleRange | null,
): Float32Array[] {
  assertPlanar(channels);
  const { startFrame, endFrame } = resolveRange(channels, range);
  const n = endFrame - startFrame;
  for (const channel of channels) {
    for (let i = 0; i < n; i++) channel[startFrame + i] *= fadeInMultiplier(i, n);
  }
  return channels;
}

/**
 * Applies a linear fade-out across the range (whole file when omitted): the
 * first frame keeps its original level and the last frame becomes silent.
 */
export function fadeOutLinear(
  channels: ReadonlyArray<Float32Array>,
  range?: SampleRange | null,
): Float32Array[] {
  assertPlanar(channels);
  const { startFrame, endFrame } = resolveRange(channels, range);
  const n = endFrame - startFrame;
  const out = copyChannels(channels);
  for (const channel of out) {
    for (let i = 0; i < n; i++) channel[startFrame + i] *= fadeOutMultiplier(i, n);
  }
  return out;
}

/** Applies a fade-out in place to channel buffers owned by a worker. */
export function fadeOutLinearInPlace(
  channels: Float32Array[],
  range?: SampleRange | null,
): Float32Array[] {
  assertPlanar(channels);
  const { startFrame, endFrame } = resolveRange(channels, range);
  const n = endFrame - startFrame;
  for (const channel of channels) {
    for (let i = 0; i < n; i++) channel[startFrame + i] *= fadeOutMultiplier(i, n);
  }
  return channels;
}

/** Reverses the samples inside the range (whole file when omitted). */
export function reverse(
  channels: ReadonlyArray<Float32Array>,
  range?: SampleRange | null,
): Float32Array[] {
  assertPlanar(channels);
  const { startFrame, endFrame } = resolveRange(channels, range);
  const out = copyChannels(channels);
  for (const channel of out) {
    for (let lo = startFrame, hi = endFrame - 1; lo < hi; lo++, hi--) {
      const tmp = channel[lo];
      channel[lo] = channel[hi];
      channel[hi] = tmp;
    }
  }
  return out;
}

/** Reverses in place inside channel buffers owned by a worker. */
export function reverseInPlace(
  channels: Float32Array[],
  range?: SampleRange | null,
): Float32Array[] {
  assertPlanar(channels);
  const { startFrame, endFrame } = resolveRange(channels, range);
  for (const channel of channels) {
    for (let lo = startFrame, hi = endFrame - 1; lo < hi; lo++, hi--) {
      const tmp = channel[lo];
      channel[lo] = channel[hi];
      channel[hi] = tmp;
    }
  }
  return channels;
}

/** Replaces the range (whole file when omitted) with silence. */
export function silence(
  channels: ReadonlyArray<Float32Array>,
  range?: SampleRange | null,
): Float32Array[] {
  assertPlanar(channels);
  const { startFrame, endFrame } = resolveRange(channels, range);
  const out = copyChannels(channels);
  for (const channel of out) channel.fill(0, startFrame, endFrame);
  return out;
}

/** Silences in place inside channel buffers owned by a worker. */
export function silenceInPlace(
  channels: Float32Array[],
  range?: SampleRange | null,
): Float32Array[] {
  assertPlanar(channels);
  const { startFrame, endFrame } = resolveRange(channels, range);
  for (const channel of channels) channel.fill(0, startFrame, endFrame);
  return channels;
}

/**
 * Crops the audio to the given range (the inverse of deleting everything
 * outside the selection).
 *
 * @param channels Planar channel buffers (not mutated).
 * @param range Frame range to keep (clamped; must not be empty).
 * @returns New channel buffers containing only the range.
 */
export function trimToRange(
  channels: ReadonlyArray<Float32Array>,
  range: SampleRange,
): Float32Array[] {
  assertPlanar(channels);
  const { startFrame, endFrame } = clampRange(range, frameCount(channels));
  if (endFrame <= startFrame) {
    throw new RangeError('Cannot trim to an empty range');
  }
  return channels.map((channel) => channel.slice(startFrame, endFrame));
}

/**
 * Returns views into transferred channel buffers without copying them. The
 * worker owns those buffers, so retaining the original backing allocation is
 * safe and avoids a second full-size allocation for a trim.
 */
export function trimToRangeInPlace(channels: Float32Array[], range: SampleRange): Float32Array[] {
  assertPlanar(channels);
  const { startFrame, endFrame } = clampRange(range, frameCount(channels));
  if (endFrame <= startFrame) {
    throw new RangeError('Cannot trim to an empty range');
  }
  return channels.map((channel) => channel.subarray(startFrame, endFrame));
}

/**
 * Crossfade applied where two cut edges meet, in seconds.
 *
 * A hard join steps the waveform by whatever the two edges happen to differ by,
 * which clicks. Measured on tones, 2 ms brings the step at the join below the
 * signal's own sample-to-sample slope at both a high and a low fundamental
 * (440 Hz: 0.221 -> 0.014 against a 0.017 slope; 55 Hz: 0.446 -> 0.002 against
 * 0.002). Longer does not improve it and makes anti-correlated edges cancel
 * across a wider window.
 */
export const CUT_CROSSFADE_SECONDS = 0.002;

/** Crossfade length in frames for {@link CUT_CROSSFADE_SECONDS}. */
export function cutCrossfadeFrames(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  return Math.max(0, Math.round(CUT_CROSSFADE_SECONDS * sampleRate));
}

/**
 * Concatenates one channel's segments, crossfading each join over `fadeFrames`
 * so the seam does not step. Every overlap consumes the end of the segment
 * before it, so the result is shorter than a plain concatenation by the sum of
 * the applied fades.
 */
function joinSegments(segments: ReadonlyArray<Float32Array>, fadeFrames: number): Float32Array {
  let out = segments[0] ?? new Float32Array(0);
  for (const next of segments.slice(1)) {
    const fade = Math.max(0, Math.min(fadeFrames, out.length, next.length));
    const joined = new Float32Array(out.length + next.length - fade);
    joined.set(out.subarray(0, out.length - fade), 0);
    const joinAt = out.length - fade;
    for (let i = 0; i < fade; i += 1) {
      const mix = (i + 1) / (fade + 1);
      joined[joinAt + i] = out[joinAt + i] * (1 - mix) + next[i] * mix;
    }
    joined.set(next.subarray(fade), joinAt + fade);
    out = joined;
  }
  return out;
}

/**
 * Deletes the range and closes the gap, crossfading the two edges so the join
 * does not click.
 *
 * The cut is at the same frame in every channel — a per-channel zero-crossing
 * search would land on different frames and shift the stereo image.
 *
 * @param channels Planar channel buffers (not mutated).
 * @param range Frame range to remove (clamped; must not be empty).
 * @param fadeFrames Crossfade length; see {@link cutCrossfadeFrames}.
 * @returns New, shorter channel buffers.
 * @throws RangeError when the range is empty or covers the whole file.
 */
export function deleteRange(
  channels: ReadonlyArray<Float32Array>,
  range: SampleRange,
  fadeFrames = 0,
): Float32Array[] {
  assertPlanar(channels);
  const total = frameCount(channels);
  const { startFrame, endFrame } = clampRange(range, total);
  if (endFrame <= startFrame) {
    throw new RangeError('Cannot delete an empty range');
  }
  if (startFrame === 0 && endFrame === total) {
    throw new RangeError('Cannot delete the whole file');
  }
  return channels.map((channel) =>
    joinSegments([channel.subarray(0, startFrame), channel.subarray(endFrame)], fadeFrames),
  );
}

/**
 * Inserts a copy of the range directly after itself, crossfading both new
 * joins. With nothing selected the whole file is doubled.
 *
 * @param channels Planar channel buffers (not mutated).
 * @param range Frame range to repeat (clamped; must not be empty).
 * @param fadeFrames Crossfade length; see {@link cutCrossfadeFrames}.
 * @returns New, longer channel buffers.
 * @throws RangeError when the range is empty.
 */
export function duplicateRange(
  channels: ReadonlyArray<Float32Array>,
  range?: SampleRange | null,
  fadeFrames = 0,
): Float32Array[] {
  assertPlanar(channels);
  const { startFrame, endFrame } = resolveRange(channels, range);
  if (endFrame <= startFrame) {
    throw new RangeError('Cannot duplicate an empty range');
  }
  return channels.map((channel) =>
    joinSegments(
      [
        channel.subarray(0, endFrame),
        channel.subarray(startFrame, endFrame),
        channel.subarray(endFrame),
      ],
      fadeFrames,
    ),
  );
}

/**
 * Replaces the range with a replacement segment, which may have a different
 * length (used to splice processed audio such as a time stretch back in).
 *
 * Where the range has untouched audio on a side, that edge of the replacement
 * is crossfaded with the audio it replaces, so the seam does not step and the
 * result keeps its length. An edge on the file boundary is left as is.
 *
 * @param channels Planar channel buffers (not mutated).
 * @param range Frame range to replace (clamped).
 * @param replacement One segment per channel, all of equal length.
 * @param fadeFrames Crossfade length; see {@link cutCrossfadeFrames}.
 * @returns New channel buffers with the range replaced.
 */
export function spliceRange(
  channels: ReadonlyArray<Float32Array>,
  range: SampleRange,
  replacement: ReadonlyArray<Float32Array>,
  fadeFrames = 0,
): Float32Array[] {
  assertPlanar(channels);
  if (replacement.length !== channels.length) {
    throw new RangeError(
      `Replacement has ${replacement.length} channels, expected ${channels.length}`,
    );
  }
  const segmentFrames = replacement[0]?.length ?? 0;
  for (const segment of replacement) {
    if (segment.length !== segmentFrames) {
      throw new RangeError('All replacement channels must have the same length');
    }
  }
  const total = frameCount(channels);
  const { startFrame, endFrame } = clampRange(range, total);
  // Both edges need a full fade of their own half; a shorter selection keeps its hard join.
  const wanted = Math.max(0, Math.floor(fadeFrames));
  const fade =
    wanted > 0 && 2 * wanted <= endFrame - startFrame && 2 * wanted <= segmentFrames ? wanted : 0;
  const fadeIn = startFrame > 0 ? fade : 0;
  const fadeOut = endFrame < total ? fade : 0;
  return channels.map((channel, c) => {
    const out = new Float32Array(channel.length - (endFrame - startFrame) + segmentFrames);
    out.set(channel.subarray(0, startFrame), 0);
    out.set(replacement[c], startFrame);
    out.set(channel.subarray(endFrame), startFrame + segmentFrames);
    for (let i = 0; i < fadeIn; i += 1) {
      const mix = (i + 1) / (fadeIn + 1);
      out[startFrame + i] = channel[startFrame + i] * (1 - mix) + replacement[c][i] * mix;
    }
    for (let i = 0; i < fadeOut; i += 1) {
      const mix = (i + 1) / (fadeOut + 1);
      const at = startFrame + segmentFrames - fadeOut + i;
      out[at] =
        replacement[c][segmentFrames - fadeOut + i] * (1 - mix) +
        channel[endFrame - fadeOut + i] * mix;
    }
    return out;
  });
}
