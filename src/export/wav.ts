/**
 * Pure WAV (RIFF/WAVE) encoder for planar float audio.
 *
 * Supports 16-bit and 24-bit integer PCM (format tag 1) and 32-bit IEEE
 * float (format tag 3, written with the spec-required fact chunk). Integer
 * formats hard-clip the input to [-1, 1] and quantize with the asymmetric
 * signed-PCM mapping shared across the codecs (see {@link scalePcmSample}); the
 * float format passes samples through untouched (over-range values are
 * preserved). Optional TPDF dither (+-1 LSB triangular noise before rounding)
 * is applied to 16-bit output only.
 */

import { scalePcmSample } from './pcm-quantize';

/** Output sample format: integer bit depth, or '32f' for IEEE float. */
export type WavBitDepth = 16 | 24 | '32f';

/** Options for {@link encodeWav}. */
export interface EncodeWavOptions {
  /** Output sample format (default 16). */
  bitDepth?: WavBitDepth;
  /** Apply TPDF dither before 16-bit quantization (default false; ignored for 24/'32f'). */
  dither?: boolean;
  /** Uniform [0, 1) noise source for the dither (default Math.random; injectable for tests). */
  random?: () => number;
}

/** Bytes per sample for each supported format. */
function bytesPerSample(bitDepth: WavBitDepth): number {
  return bitDepth === '32f' ? 4 : bitDepth / 8;
}

/** Largest value representable by a classic RIFF/WAVE 32-bit chunk-size field. */
export const WAV_RIFF_SIZE_MAX = 0xffff_ffff;

/**
 * Returns the complete classic RIFF/WAVE file size, rejecting layouts whose
 * data or RIFF chunks would wrap their 32-bit size fields. This pure helper is
 * intentionally usable for >4 GiB boundary tests without allocating audio.
 */
export function wavFileSize(frames: number, numChannels: number, bitDepth: WavBitDepth): number {
  if (!Number.isSafeInteger(frames) || frames < 0) {
    throw new RangeError(`WAV frame count must be a non-negative safe integer, got ${frames}`);
  }
  if (!Number.isSafeInteger(numChannels) || numChannels <= 0) {
    throw new RangeError(`WAV channel count must be a positive safe integer, got ${numChannels}`);
  }
  const sampleBytes = bytesPerSample(bitDepth);
  const blockAlign = numChannels * sampleBytes;
  if (blockAlign > 0xffff) {
    throw new RangeError(`WAV block alignment exceeds 16-bit RIFF field: ${blockAlign}`);
  }
  const dataSize = frames * blockAlign;
  const dataPad = dataSize % 2;
  const fmtSize = bitDepth === '32f' ? 18 : 16;
  const factBytes = bitDepth === '32f' ? 12 : 0;
  const riffSize = 4 + (8 + fmtSize) + factBytes + (8 + dataSize + dataPad);
  if (
    !Number.isSafeInteger(dataSize) ||
    dataSize > WAV_RIFF_SIZE_MAX ||
    !Number.isSafeInteger(riffSize) ||
    riffSize > WAV_RIFF_SIZE_MAX
  ) {
    throw new RangeError(
      'WAV exceeds the classic RIFF 4 GiB limit; shorten the range, lower the sample rate, or export stems.',
    );
  }
  return 8 + riffSize;
}

/** Writes an ASCII four-character chunk tag. */
function writeTag(view: DataView, offset: number, tag: string): void {
  for (let i = 0; i < 4; i++) {
    view.setUint8(offset + i, tag.charCodeAt(i));
  }
}

/** Clamps a sample to [-1, 1]. */
function clampSample(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

/**
 * Encodes planar audio buffers into a complete WAV file.
 *
 * @param channels Planar channel buffers of equal length (>= 1 channel).
 * @param sampleRate Sample rate in Hz (positive integer).
 * @param options Output format options.
 * @returns The WAV file bytes.
 * @throws RangeError on empty channel lists, mismatched lengths, a bad
 *   sample rate or an unsupported bit depth.
 */
export function encodeWav(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  options: EncodeWavOptions = {},
): Uint8Array {
  const bitDepth = options.bitDepth ?? 16;
  if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== '32f') {
    throw new RangeError(`Unsupported WAV bit depth: ${String(bitDepth)}`);
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`WAV sample rate must be a positive integer, got ${sampleRate}`);
  }
  if (channels.length === 0) {
    throw new RangeError('WAV encoding requires at least one channel');
  }
  const frames = channels[0].length;
  for (const channel of channels) {
    if (channel.length !== frames) {
      throw new RangeError('All WAV channels must have the same length');
    }
  }

  const numChannels = channels.length;
  const isFloat = bitDepth === '32f';
  const sampleBytes = bytesPerSample(bitDepth);
  const blockAlign = numChannels * sampleBytes;
  const dataSize = frames * blockAlign;
  // RIFF chunks are word-aligned: odd-sized data payloads get a pad byte that
  // counts toward the RIFF size but not toward the data chunk size.
  const dataPad = dataSize % 2;
  // Non-PCM formats carry the cbSize field (fmt size 18) and a fact chunk.
  const fmtSize = isFloat ? 18 : 16;
  const factBytes = isFloat ? 8 + 4 : 0;
  const riffSize = 4 + (8 + fmtSize) + factBytes + (8 + dataSize + dataPad);
  const out = new Uint8Array(wavFileSize(frames, numChannels, bitDepth));
  const view = new DataView(out.buffer);

  let offset = 0;
  writeTag(view, offset, 'RIFF');
  view.setUint32(offset + 4, riffSize, true);
  writeTag(view, offset + 8, 'WAVE');
  offset += 12;

  writeTag(view, offset, 'fmt ');
  view.setUint32(offset + 4, fmtSize, true);
  view.setUint16(offset + 8, isFloat ? 3 : 1, true); // format tag: 1 = PCM, 3 = IEEE float
  view.setUint16(offset + 10, numChannels, true);
  view.setUint32(offset + 12, sampleRate, true);
  view.setUint32(offset + 16, sampleRate * blockAlign, true); // byte rate
  view.setUint16(offset + 20, blockAlign, true);
  view.setUint16(offset + 22, isFloat ? 32 : bitDepth, true);
  if (isFloat) view.setUint16(offset + 24, 0, true); // cbSize: no extension bytes
  offset += 8 + fmtSize;

  if (isFloat) {
    writeTag(view, offset, 'fact');
    view.setUint32(offset + 4, 4, true);
    view.setUint32(offset + 8, frames, true);
    offset += 12;
  }

  writeTag(view, offset, 'data');
  view.setUint32(offset + 4, dataSize, true);
  offset += 8;

  const dither = options.dither === true && bitDepth === 16;
  const random = options.random ?? Math.random;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = channels[c][i];
      if (bitDepth === '32f') {
        view.setFloat32(offset, sample, true);
      } else if (bitDepth === 16) {
        let scaled = scalePcmSample(clampSample(sample), 0x7fff, 0x8000);
        if (dither) scaled += random() - random();
        const v = Math.min(0x7fff, Math.max(-0x8000, Math.round(scaled)));
        view.setInt16(offset, v, true);
      } else {
        const scaled = scalePcmSample(clampSample(sample), 0x7fffff, 0x800000);
        const v = Math.min(0x7fffff, Math.max(-0x800000, Math.round(scaled)));
        view.setUint8(offset, v & 0xff);
        view.setUint8(offset + 1, (v >> 8) & 0xff);
        view.setUint8(offset + 2, (v >> 16) & 0xff);
      }
      offset += sampleBytes;
    }
  }
  // The optional pad byte is already zero-initialized.
  return out;
}
