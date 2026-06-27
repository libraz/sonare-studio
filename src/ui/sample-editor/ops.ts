/**
 * Pure offline sample-editing operations for the sample editor.
 *
 * Every function takes planar channel buffers plus an optional frame range
 * and returns NEW buffers — inputs are never mutated, so callers can hand in
 * cached (shared) asset audio directly. When no range is given an operation
 * applies to the whole file. Ranges are clamped to the buffer bounds.
 */

import { dbToLinear } from '@/lib/db';

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
  const startFrame = Math.min(Math.max(0, Math.floor(range.startFrame)), totalFrames);
  const endFrame = Math.min(Math.max(startFrame, Math.floor(range.endFrame)), totalFrames);
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

/** Converts decibels to a linear gain factor (0 dB = 1.0). */
export function dbToGain(db: number): number {
  return dbToLinear(db);
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
  const gain = dbToGain(gainDb);
  const out = copyChannels(channels);
  for (const channel of out) {
    for (let i = startFrame; i < endFrame; i++) channel[i] *= gain;
  }
  return out;
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
  const gain = dbToGain(targetDb) / peak;
  for (const channel of out) {
    for (let i = resolved.startFrame; i < resolved.endFrame; i++) channel[i] *= gain;
  }
  return out;
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
 * Replaces the range with a replacement segment, which may have a different
 * length (used to splice processed audio such as a time stretch back in).
 *
 * @param channels Planar channel buffers (not mutated).
 * @param range Frame range to replace (clamped).
 * @param replacement One segment per channel, all of equal length.
 * @returns New channel buffers with the range replaced.
 */
export function spliceRange(
  channels: ReadonlyArray<Float32Array>,
  range: SampleRange,
  replacement: ReadonlyArray<Float32Array>,
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
  const { startFrame, endFrame } = clampRange(range, frameCount(channels));
  return channels.map((channel, c) => {
    const out = new Float32Array(channel.length - (endFrame - startFrame) + segmentFrames);
    out.set(channel.subarray(0, startFrame), 0);
    out.set(replacement[c], startFrame);
    out.set(channel.subarray(endFrame), startFrame + segmentFrames);
    return out;
  });
}
