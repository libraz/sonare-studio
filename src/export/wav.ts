/**
 * Pure WAV (RIFF/WAVE) encoder for planar float audio.
 *
 * Supports 16-bit and 24-bit integer PCM (format tag 1) and 32-bit IEEE
 * float (format tag 3, written with the spec-required fact chunk). Integer
 * formats hard-clip the input to [-1, 1] and quantize with the asymmetric
 * signed-PCM mapping shared across the codecs (see {@link quantizePcmSample}); the
 * float format passes samples through untouched (over-range values are
 * preserved). Optional TPDF dither (+-1 LSB triangular noise before rounding)
 * is applied to 16-bit output only.
 */

import type { AudioFileMetadata } from './audio-file-metadata';
import { quantizePcmSample } from './pcm-quantize';

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
  /** BWF/cue metadata for a rendered delivery. Omitted for plain asset WAVs. */
  metadata?: AudioFileMetadata;
}

/** Bytes per sample for each supported format. */
function bytesPerSample(bitDepth: WavBitDepth): number {
  return bitDepth === '32f' ? 4 : bitDepth / 8;
}

/** Largest value representable by a classic RIFF/WAVE 32-bit chunk-size field. */
export const WAV_RIFF_SIZE_MAX = 0xffff_ffff;

/** Fully resolved RIFF chunk geometry shared by sizing and encoding. */
export interface WavLayout {
  sampleBytes: number;
  blockAlign: number;
  dataSize: number;
  dataPad: number;
  fmtSize: number;
  factBytes: number;
  riffSize: number;
  fileSize: number;
}

/**
 * Resolves the classic RIFF/WAVE chunk layout, rejecting fields that would
 * overflow. This pure helper is usable for >4 GiB boundary tests without
 * allocating audio.
 */
export function wavLayout(frames: number, numChannels: number, bitDepth: WavBitDepth): WavLayout {
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
  return {
    sampleBytes,
    blockAlign,
    dataSize,
    dataPad,
    fmtSize,
    factBytes,
    riffSize,
    fileSize: 8 + riffSize,
  };
}

/** Returns the complete classic RIFF/WAVE file size. */
export function wavFileSize(frames: number, numChannels: number, bitDepth: WavBitDepth): number {
  return wavLayout(frames, numChannels, bitDepth).fileSize;
}

/** Writes an ASCII four-character chunk tag. */
function writeTag(view: DataView, offset: number, tag: string): void {
  for (let i = 0; i < 4; i++) {
    view.setUint8(offset + i, tag.charCodeAt(i));
  }
}

function textBytes(value: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let index = 0; index < Math.min(value.length, length); index += 1) {
    const code = value.charCodeAt(index);
    out[index] = code >= 0x20 && code <= 0x7e ? code : 0x3f;
  }
  return out;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function chunk(tag: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length + (payload.length & 1));
  const view = new DataView(out.buffer);
  writeTag(view, 0, tag);
  view.setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

function bextChunk(metadata: AudioFileMetadata | undefined): Uint8Array | null {
  if (!metadata) return null;
  const payload = new Uint8Array(602);
  payload.set(textBytes(metadata.title ?? '', 256), 0);
  payload.set(textBytes(metadata.originator ?? 'Sonare Studio', 32), 256);
  payload.set(textBytes(metadata.originatorReference ?? '', 32), 288);
  payload.set(textBytes(metadata.originationDate ?? '', 10), 320);
  payload.set(textBytes(metadata.originationTime ?? '', 8), 330);
  const reference = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, metadata.timeReference ?? 0));
  const view = new DataView(payload.buffer);
  view.setUint32(338, reference >>> 0, true);
  view.setUint32(342, Math.floor(reference / 0x1_0000_0000), true);
  view.setUint16(346, 2, true); // BWF v2
  return chunk('bext', payload);
}

function cueChunks(metadata: AudioFileMetadata | undefined): Uint8Array {
  const markers = (metadata?.markers ?? []).filter(
    (marker) =>
      Number.isSafeInteger(marker.sampleOffset) &&
      marker.sampleOffset >= 0 &&
      marker.sampleOffset <= 0xffff_ffff,
  );
  if (markers.length === 0) return new Uint8Array();
  const cue = new Uint8Array(4 + markers.length * 24);
  const cueView = new DataView(cue.buffer);
  cueView.setUint32(0, markers.length, true);
  const labels: Uint8Array[] = [];
  for (let index = 0; index < markers.length; index += 1) {
    const offset = 4 + index * 24;
    cueView.setUint32(offset, index + 1, true);
    cueView.setUint32(offset + 4, markers[index].sampleOffset, true);
    writeTag(cueView, offset + 8, 'data');
    cueView.setUint32(offset + 20, markers[index].sampleOffset, true);
    const label = utf8(markers[index].name);
    const labl = new Uint8Array(4 + label.length + 1);
    new DataView(labl.buffer).setUint32(0, index + 1, true);
    labl.set(label, 4);
    labels.push(chunk('labl', labl));
  }
  const adtlLength = 4 + labels.reduce((length, label) => length + label.length, 0);
  const adtl = new Uint8Array(adtlLength);
  const adtlView = new DataView(adtl.buffer);
  writeTag(adtlView, 0, 'adtl');
  let offset = 4;
  for (const label of labels) {
    adtl.set(label, offset);
    offset += label.length;
  }
  const cueChunk = chunk('cue ', cue);
  const listChunk = chunk('LIST', adtl);
  const out = new Uint8Array(cueChunk.length + listChunk.length);
  out.set(cueChunk);
  out.set(listChunk, cueChunk.length);
  return out;
}

function wavMetadataChunks(metadata: AudioFileMetadata | undefined): {
  beforeData: Uint8Array;
  afterData: Uint8Array;
} {
  const beforeData = bextChunk(metadata) ?? new Uint8Array();
  return { beforeData, afterData: cueChunks(metadata) };
}

/** Returns the chunks written after a WAV data payload (cue/list labels). */
export function wavTrailingMetadata(metadata: AudioFileMetadata | undefined): Uint8Array {
  return wavMetadataChunks(metadata).afterData;
}

/** Builds the RIFF/fmt/(fact)/data prefix for a known-length WAV stream. */
export function wavHeader(
  frames: number,
  numChannels: number,
  sampleRate: number,
  bitDepth: WavBitDepth,
  options: Pick<EncodeWavOptions, 'metadata'> = {},
): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`WAV sample rate must be a positive integer, got ${sampleRate}`);
  }
  const layout = wavLayout(frames, numChannels, bitDepth);
  const metadata = wavMetadataChunks(options.metadata);
  const header = new Uint8Array(
    layout.fileSize - layout.dataSize - layout.dataPad + metadata.beforeData.length,
  );
  const view = new DataView(header.buffer);
  const isFloat = bitDepth === '32f';
  let offset = 0;
  writeTag(view, offset, 'RIFF');
  view.setUint32(
    offset + 4,
    layout.riffSize + metadata.beforeData.length + metadata.afterData.length,
    true,
  );
  writeTag(view, offset + 8, 'WAVE');
  offset += 12;
  writeTag(view, offset, 'fmt ');
  view.setUint32(offset + 4, layout.fmtSize, true);
  view.setUint16(offset + 8, isFloat ? 3 : 1, true);
  view.setUint16(offset + 10, numChannels, true);
  view.setUint32(offset + 12, sampleRate, true);
  view.setUint32(offset + 16, sampleRate * layout.blockAlign, true);
  view.setUint16(offset + 20, layout.blockAlign, true);
  view.setUint16(offset + 22, isFloat ? 32 : bitDepth, true);
  if (isFloat) view.setUint16(offset + 24, 0, true);
  offset += 8 + layout.fmtSize;
  if (isFloat) {
    writeTag(view, offset, 'fact');
    view.setUint32(offset + 4, 4, true);
    view.setUint32(offset + 8, frames, true);
  }
  offset += isFloat ? 12 : 0;
  header.set(metadata.beforeData, offset);
  offset += metadata.beforeData.length;
  const dataOffset = offset;
  writeTag(view, dataOffset, 'data');
  view.setUint32(dataOffset + 4, layout.dataSize, true);
  return header;
}

/** Encodes a PCM block for a WAV stream (no RIFF header). */
export function encodeWavChunk(
  channels: ReadonlyArray<Float32Array>,
  bitDepth: WavBitDepth,
  options: EncodeWavOptions = {},
): Uint8Array {
  if (channels.length === 0) throw new RangeError('WAV encoding requires at least one channel');
  const frames = channels[0].length;
  if (channels.some((channel) => channel.length !== frames)) {
    throw new RangeError('All WAV channels must have the same length');
  }
  const sampleBytes = bytesPerSample(bitDepth);
  const out = new Uint8Array(frames * channels.length * sampleBytes);
  const view = new DataView(out.buffer);
  const dither = options.dither === true && bitDepth === 16;
  const random = options.random ?? Math.random;
  let offset = 0;
  for (let i = 0; i < frames; i++) {
    for (const channel of channels) {
      const sample = channel[i];
      if (bitDepth === '32f') view.setFloat32(offset, Number.isFinite(sample) ? sample : 0, true);
      else if (bitDepth === 16) {
        view.setInt16(
          offset,
          quantizePcmSample(sample, 0x7fff, 0x8000, dither ? random() - random() : 0),
          true,
        );
      } else {
        const value = quantizePcmSample(sample, 0x7fffff, 0x800000);
        view.setUint8(offset, value & 0xff);
        view.setUint8(offset + 1, (value >> 8) & 0xff);
        view.setUint8(offset + 2, (value >> 16) & 0xff);
      }
      offset += sampleBytes;
    }
  }
  return out;
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
  const layout = wavLayout(frames, numChannels, bitDepth);
  const metadata = wavMetadataChunks(options.metadata);
  const header = wavHeader(frames, numChannels, sampleRate, bitDepth, options);
  const out = new Uint8Array(
    header.length + layout.dataSize + layout.dataPad + metadata.afterData.length,
  );
  out.set(header);
  const view = new DataView(out.buffer);
  let offset = header.length;

  const dither = options.dither === true && bitDepth === 16;
  const random = options.random ?? Math.random;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = channels[c][i];
      if (bitDepth === '32f') {
        view.setFloat32(offset, Number.isFinite(sample) ? sample : 0, true);
      } else if (bitDepth === 16) {
        const v = quantizePcmSample(sample, 0x7fff, 0x8000, dither ? random() - random() : 0);
        view.setInt16(offset, v, true);
      } else {
        const v = quantizePcmSample(sample, 0x7fffff, 0x800000);
        view.setUint8(offset, v & 0xff);
        view.setUint8(offset + 1, (v >> 8) & 0xff);
        view.setUint8(offset + 2, (v >> 16) & 0xff);
      }
      offset += layout.sampleBytes;
    }
  }
  // The optional pad byte is already zero-initialized.
  out.set(metadata.afterData, offset + layout.dataPad);
  return out;
}
