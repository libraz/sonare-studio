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

import type { AudioFileMetadata } from './audio-file-metadata';
import {
  type AudioEncodeOptions,
  type AudioEncoder,
  listEncoders,
  registerEncoder,
} from './codecs';
import { quantizePcmSample } from './pcm-quantize';

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

/** libmp3lame's fixed encode delay used by the bundled lamejs port. */
const LAME_ENCODER_DELAY = 576;

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
  /** ID3 title/artist values for a rendered delivery. */
  metadata?: AudioFileMetadata;
}

function writeUint32Be(out: Uint8Array, offset: number, value: number): void {
  new DataView(out.buffer).setUint32(offset, value, false);
}

function writeSynchsafe(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 21) & 0x7f;
  out[offset + 1] = (value >>> 14) & 0x7f;
  out[offset + 2] = (value >>> 7) & 0x7f;
  out[offset + 3] = value & 0x7f;
}

function id3TextFrame(id: string, value: string): Uint8Array {
  const text = new TextEncoder().encode(value);
  const out = new Uint8Array(10 + 1 + text.length);
  out.set(new TextEncoder().encode(id), 0);
  writeSynchsafe(out, 4, 1 + text.length);
  out[10] = 3; // UTF-8
  out.set(text, 11);
  return out;
}

function id3Tag(metadata: AudioFileMetadata | undefined): Uint8Array {
  const frames = [
    ...(metadata?.title ? [id3TextFrame('TIT2', metadata.title)] : []),
    ...(metadata?.originator ? [id3TextFrame('TPE1', metadata.originator)] : []),
  ];
  if (frames.length === 0) return new Uint8Array();
  const size = frames.reduce((total, frame) => total + frame.length, 0);
  const out = new Uint8Array(10 + size);
  out.set([0x49, 0x44, 0x33, 4, 0, 0], 0); // ID3v2.4, no flags
  writeSynchsafe(out, 6, size);
  let offset = 10;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

function mpegFrameSize(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
    throw new RangeError('MP3 encoder did not produce an MPEG frame header');
  }
  const version = (bytes[offset + 1] >> 3) & 0x3;
  const layer = (bytes[offset + 1] >> 1) & 0x3;
  const bitrateIndex = (bytes[offset + 2] >> 4) & 0xf;
  const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x3;
  if (
    version !== 3 ||
    layer !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleRateIndex === 3
  ) {
    throw new RangeError('MP3 encoder produced an unsupported MPEG frame');
  }
  const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const sampleRates = [44100, 48000, 32000];
  return (
    Math.floor((144000 * bitrates[bitrateIndex]) / sampleRates[sampleRateIndex]) +
    ((bytes[offset + 2] >> 1) & 1)
  );
}

function mpegFrameCount(bytes: Uint8Array): number {
  let count = 0;
  for (let offset = 0; offset < bytes.length; ) {
    const size = mpegFrameSize(bytes, offset);
    offset += size;
    if (offset > bytes.length) throw new RangeError('MP3 encoder produced a truncated MPEG frame');
    count += 1;
  }
  return count;
}

function encoderPadding(inputFrames: number): number {
  let padding = ENCODE_BLOCK_FRAMES - ((inputFrames + LAME_ENCODER_DELAY) % ENCODE_BLOCK_FRAMES);
  if (padding < 576) padding += ENCODE_BLOCK_FRAMES;
  return padding;
}

/**
 * Builds the CBR Info/LAME frame which the public lamejs wrapper omits.
 * The first frame is a metadata frame, matching libmp3lame's own VBR-tag
 * reservation. Players can use its delay/padding triplet for gapless timing.
 */
function infoFrame(audio: Uint8Array, inputFrames: number): Uint8Array {
  if (audio.length === 0) return new Uint8Array();
  const size = mpegFrameSize(audio, 0);
  const out = new Uint8Array(size);
  out.set(audio.slice(0, 4));
  const hasCrc = (out[1] & 1) === 0;
  const channelMode = (out[3] >> 6) & 0x3;
  const sideInfoBytes = channelMode === 3 ? 17 : 32;
  const infoOffset = 4 + (hasCrc ? 2 : 0) + sideInfoBytes;
  const lameOffset = infoOffset + 16;
  if (lameOffset + 24 > out.length) {
    throw new RangeError('MP3 frame is too small for required gapless metadata');
  }
  out.set([0x49, 0x6e, 0x66, 0x6f], infoOffset); // Info (CBR Xing header)
  writeUint32Be(out, infoOffset + 4, 0x00000003); // frame count + byte count
  writeUint32Be(out, infoOffset + 8, mpegFrameCount(audio));
  writeUint32Be(out, infoOffset + 12, audio.length + out.length);
  out.set(new TextEncoder().encode('LAME3.100'), lameOffset);
  const delay = LAME_ENCODER_DELAY;
  const padding = encoderPadding(inputFrames);
  out[lameOffset + 21] = delay >> 4;
  out[lameOffset + 22] = ((delay & 0xf) << 4) | (padding >> 8);
  out[lameOffset + 23] = padding & 0xff;
  return out;
}

/** Converts one bounded float block to signed 16-bit PCM with hard clipping. */
function floatBlockTo16(samples: Float32Array, start: number, end: number): Int16Array {
  const out = new Int16Array(end - start);
  for (let i = start; i < end; i++) {
    out[i - start] = quantizePcmSample(samples[i], 0x7fff, 0x8000);
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
  const audio = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    audio.set(chunk, cursor);
    cursor += chunk.length;
  }
  const info = infoFrame(audio, frames);
  const id3 = id3Tag(options.metadata);
  const out = new Uint8Array(id3.length + info.length + audio.length);
  out.set(id3);
  out.set(info, id3.length);
  out.set(audio, id3.length + info.length);
  return out;
}

/** Narrows the open encoder option bag to {@link EncodeMp3Options}. */
function toMp3Options(options: AudioEncodeOptions = {}): EncodeMp3Options {
  const out: EncodeMp3Options = {};
  const bitrate = options['bitrate'];
  // Pass numbers through; encodeMp3 rejects values outside MP3_BITRATES.
  if (typeof bitrate === 'number') out.bitrate = bitrate as Mp3Bitrate;
  const metadata = options['metadata'];
  if (metadata && typeof metadata === 'object') out.metadata = metadata as AudioFileMetadata;
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
