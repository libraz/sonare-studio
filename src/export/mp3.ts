/**
 * MP3 (MPEG-1 Layer III) encoder backed by the pure-JS lamejs port
 * (@breezystack/lamejs). The library is lazy-loaded on the first encode so
 * importing this module stays cheap, and it runs unchanged on the main
 * thread and inside module workers (no remote assets — the encoder ships in
 * the same-origin app bundle and is far below deployment size limits).
 *
 * Output is constant-bitrate; MPEG-1 Layer III supports 32/44.1/48 kHz
 * input only, so 96 kHz mixdowns must be rendered at a supported rate
 * instead (the export option validation enforces this).
 */

import {
  type AudioEncodeOptions,
  type AudioEncoder,
  listEncoders,
  registerEncoder,
} from './codecs';

/** Registry id of the MP3 encoder. */
export const MP3_ENCODER_ID = 'mp3';

/** Selectable constant bitrates in kbps. */
export const MP3_BITRATES = [320, 256, 192, 128] as const;

/** One of the selectable constant bitrates in kbps. */
export type Mp3Bitrate = (typeof MP3_BITRATES)[number];

/** Bitrate used when none is requested. */
export const DEFAULT_MP3_BITRATE: Mp3Bitrate = 320;

/** Input sample rates MPEG-1 Layer III supports (no 96 kHz). */
export const MP3_SAMPLE_RATES = [32000, 44100, 48000] as const;

/** Frames fed to the encoder per call (one MPEG-1 Layer III frame). */
const ENCODE_BLOCK_FRAMES = 1152;

/** Returns whether a value is one of the selectable MP3 bitrates. */
export function isMp3Bitrate(value: unknown): value is Mp3Bitrate {
  return (MP3_BITRATES as ReadonlyArray<unknown>).includes(value);
}

/** Returns whether a sample rate is encodable as MPEG-1 Layer III. */
export function isMp3SampleRate(sampleRate: number): boolean {
  return (MP3_SAMPLE_RATES as ReadonlyArray<number>).includes(sampleRate);
}

/** Options for {@link encodeMp3}. */
export interface EncodeMp3Options {
  /** Constant bitrate in kbps (default {@link DEFAULT_MP3_BITRATE}). */
  bitrate?: Mp3Bitrate;
}

/** Converts one bounded float block to signed 16-bit PCM with hard clipping. */
function floatBlockTo16(samples: Float32Array, start: number, end: number): Int16Array {
  const out = new Int16Array(end - start);
  for (let i = start; i < end; i++) {
    const value = Math.min(1, Math.max(-1, samples[i]));
    out[i - start] = Math.round(value < 0 ? value * 0x8000 : value * 0x7fff);
  }
  return out;
}

/**
 * Encodes planar audio buffers into a complete CBR MP3 file.
 *
 * @param channels Planar channel buffers of equal length (1 = mono, 2 = stereo).
 * @param sampleRate Input sample rate in Hz; must be 32000, 44100 or 48000.
 * @param options Bitrate selection.
 * @returns The MP3 file bytes.
 * @throws RangeError on an unsupported channel count, mismatched channel
 *   lengths, an unsupported sample rate or an unsupported bitrate.
 */
export async function encodeMp3(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  options: EncodeMp3Options = {},
): Promise<Uint8Array> {
  if (channels.length !== 1 && channels.length !== 2) {
    throw new RangeError(`MP3 encoding supports 1 or 2 channels, got ${channels.length}`);
  }
  const frames = channels[0].length;
  if (channels.some((channel) => channel.length !== frames)) {
    throw new RangeError('MP3 channel buffers must have equal lengths');
  }
  if (!isMp3SampleRate(sampleRate)) {
    throw new RangeError(
      `MP3 encoding supports ${MP3_SAMPLE_RATES.join('/')} Hz input, got ${sampleRate}`,
    );
  }
  const bitrate = options.bitrate ?? DEFAULT_MP3_BITRATE;
  if (!isMp3Bitrate(bitrate)) {
    throw new RangeError(`Unsupported MP3 bitrate: ${String(bitrate)} kbps`);
  }

  // Lazy-load the encoder library only when an encode actually happens.
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const encoder = new Mp3Encoder(channels.length, sampleRate, bitrate);

  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < frames; offset += ENCODE_BLOCK_FRAMES) {
    const end = Math.min(frames, offset + ENCODE_BLOCK_FRAMES);
    const left = floatBlockTo16(channels[0], offset, end);
    const right = channels.length === 2 ? floatBlockTo16(channels[1], offset, end) : undefined;
    const chunk = right ? encoder.encodeBuffer(left, right) : encoder.encodeBuffer(left);
    if (chunk.length > 0) chunks.push(chunk);
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(tail);

  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

/** Narrows the open encoder option bag to {@link EncodeMp3Options}. */
function toMp3Options(options: AudioEncodeOptions = {}): EncodeMp3Options {
  const out: EncodeMp3Options = {};
  const bitrate = options['bitrate'];
  // Pass numbers through; encodeMp3 rejects values outside MP3_BITRATES.
  if (typeof bitrate === 'number') out.bitrate = bitrate as Mp3Bitrate;
  return out;
}

/** Creates the MP3 {@link AudioEncoder} (registry entry shape). */
export function createMp3Encoder(): AudioEncoder {
  return {
    id: MP3_ENCODER_ID,
    label: 'MP3 (CBR)',
    extension: '.mp3',
    mime: 'audio/mpeg',
    deterministic: true,
    encode: (channels, sampleRate, options) =>
      encodeMp3(channels, sampleRate, toMp3Options(options)),
  };
}

/**
 * Registers the MP3 encoder with the codec registry. Idempotent: callers may
 * invoke it any number of times (e.g. per dialog mount).
 *
 * @returns True when the encoder was registered by this call, false when it
 *   was already present.
 */
export function registerMp3Encoder(): boolean {
  if (listEncoders().some((encoder) => encoder.id === MP3_ENCODER_ID)) {
    return false;
  }
  registerEncoder(createMp3Encoder());
  return true;
}
