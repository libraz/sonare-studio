/** Interleaved float32 PCM layout and the content id derived from it. */

import { FNV1A_OFFSET_BASIS, FNV1A_SECOND_SEED, fnv1a32Bytes } from '@/lib/fnv1a';
import { InvalidAssetError } from './asset-errors';
import { MAX_AUDIO_CHANNELS, MAX_AUDIO_SAMPLES } from './resource-limits';

/**
 * Computes the deterministic content id of an audio buffer: two seeded
 * 32-bit FNV-1a passes over the raw sample bytes plus a header covering
 * sample rate and channel count, rendered as 16 hex characters.
 *
 * @param interleaved Interleaved samples (frame-major).
 * @param sampleRate Sample rate in Hz.
 * @param numChannels Channel count.
 * @returns A stable 16-character hex id.
 */
export function computeAssetId(
  interleaved: Float32Array,
  sampleRate: number,
  numChannels: number,
): string {
  const header = new TextEncoder().encode(
    `f32|sr=${sampleRate}|ch=${numChannels}|n=${interleaved.length}|`,
  );
  const body = new Uint8Array(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);
  const a = fnv1a32Bytes(body, fnv1a32Bytes(header, FNV1A_OFFSET_BASIS));
  const b = fnv1a32Bytes(body, fnv1a32Bytes(header, FNV1A_SECOND_SEED));
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/**
 * Interleaves planar channel buffers into one frame-major buffer.
 *
 * @param channels Planar channel buffers of equal length (>= 1 channel).
 * @returns Interleaved samples (L R L R ... for stereo).
 * @throws InvalidAssetError on empty input or mismatched channel lengths.
 */
export function interleaveChannels(channels: ReadonlyArray<Float32Array>): Float32Array {
  if (channels.length === 0) {
    throw new InvalidAssetError('Audio must have at least one channel');
  }
  const frames = channels[0].length;
  for (const channel of channels) {
    if (channel.length !== frames) {
      throw new InvalidAssetError('All channels must have the same length');
    }
  }
  const out = new Float32Array(frames * channels.length);
  for (let c = 0; c < channels.length; c++) {
    const channel = channels[c];
    for (let i = 0; i < frames; i++) {
      out[i * channels.length + c] = channel[i];
    }
  }
  return out;
}

/**
 * Produces an owned byte representation of planar PCM suitable for archive
 * entries and byte-for-byte conflict checks.
 */
export function interleavedPcmBytes(channels: ReadonlyArray<Float32Array>): Uint8Array {
  const interleaved = interleaveChannels(channels);
  return new Uint8Array(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength).slice();
}

/**
 * Splits an interleaved buffer into planar per-channel buffers.
 *
 * @param interleaved Interleaved samples (frame-major).
 * @param numChannels Channel count (positive integer dividing the length).
 * @returns One Float32Array per channel.
 */
export function deinterleaveChannels(
  interleaved: Float32Array,
  numChannels: number,
): Float32Array[] {
  if (!Number.isInteger(numChannels) || numChannels < 1 || numChannels > MAX_AUDIO_CHANNELS) {
    throw new InvalidAssetError(`numChannels must be a positive integer, got ${numChannels}`);
  }
  if (interleaved.length === 0 || interleaved.length > MAX_AUDIO_SAMPLES) {
    throw new InvalidAssetError(
      `Audio sample count must be between 1 and ${MAX_AUDIO_SAMPLES}, got ${interleaved.length}`,
    );
  }
  if (interleaved.length % numChannels !== 0) {
    throw new InvalidAssetError(
      `Interleaved length ${interleaved.length} is not divisible by ${numChannels} channels`,
    );
  }
  const frames = interleaved.length / numChannels;
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      out[i] = interleaved[i * numChannels + c];
    }
    channels.push(out);
  }
  return channels;
}
