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

import { utf8ByteLength } from '@/lib/payload-memory';
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

/** Returns the encoded PCM byte count for one interleaved WAV stream block. */
export function wavChunkByteLength(
  frames: number,
  numChannels: number,
  bitDepth: WavBitDepth,
): number {
  if (!Number.isSafeInteger(frames) || frames < 0) {
    throw new RangeError(`WAV frame count must be a non-negative safe integer, got ${frames}`);
  }
  if (!Number.isSafeInteger(numChannels) || numChannels <= 0) {
    throw new RangeError(`WAV channel count must be a positive safe integer, got ${numChannels}`);
  }
  const byteLength = frames * numChannels * bytesPerSample(bitDepth);
  if (!Number.isSafeInteger(byteLength)) {
    throw new RangeError(`WAV chunk byte length exceeds safe integer range: ${byteLength}`);
  }
  return byteLength;
}

/** Writes an ASCII four-character chunk tag. */
function writeTag(view: DataView, offset: number, tag: string): void {
  for (let i = 0; i < 4; i++) {
    view.setUint8(offset + i, tag.charCodeAt(i));
  }
}

function writeAscii(view: DataView, offset: number, value: string, length: number): void {
  for (let index = 0; index < Math.min(value.length, length); index += 1) {
    const code = value.charCodeAt(index);
    view.setUint8(offset + index, code >= 0x20 && code <= 0x7e ? code : 0x3f);
  }
}

/** Writes a BWF chunk directly into its final header buffer. */
function writeBext(
  view: DataView,
  offset: number,
  metadata: AudioFileMetadata | undefined,
): number {
  if (!metadata) return offset;
  writeTag(view, offset, 'bext');
  view.setUint32(offset + 4, 602, true);
  const payloadOffset = offset + 8;
  writeAscii(view, payloadOffset, metadata.title ?? '', 256);
  writeAscii(view, payloadOffset + 256, metadata.originator ?? 'Sonare Studio', 32);
  writeAscii(view, payloadOffset + 288, metadata.originatorReference ?? '', 32);
  writeAscii(view, payloadOffset + 320, metadata.originationDate ?? '', 10);
  writeAscii(view, payloadOffset + 330, metadata.originationTime ?? '', 8);
  const reference = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, metadata.timeReference ?? 0));
  view.setUint32(payloadOffset + 338, reference >>> 0, true);
  view.setUint32(payloadOffset + 342, Math.floor(reference / 0x1_0000_0000), true);
  view.setUint16(payloadOffset + 346, 2, true); // BWF v2
  return offset + 610;
}

function isWavMarker(marker: { sampleOffset: number }): boolean {
  return (
    Number.isSafeInteger(marker.sampleOffset) &&
    marker.sampleOffset >= 0 &&
    marker.sampleOffset <= 0xffff_ffff
  );
}

/** Bytes occupied by the optional BWF chunk that precedes the WAV data payload. */
function wavLeadingMetadataByteLength(metadata: AudioFileMetadata | undefined): number {
  // `bextChunk()` always emits a 602-byte payload plus its eight-byte RIFF
  // chunk header when metadata was requested, even if every field is empty.
  return metadata === undefined ? 0 : 610;
}

/**
 * Returns the byte length of the chunks written after a WAV data payload
 * without allocating their marker-label payloads.
 *
 * Streaming writers use this to reserve memory before materializing the
 * metadata. Keep its marker filtering and UTF-8 sizing in lockstep with
 * `cueChunks()`.
 */
export function wavTrailingMetadataByteLength(metadata: AudioFileMetadata | undefined): number {
  let markerCount = 0;
  let labelsLength = 0;
  for (const marker of metadata?.markers ?? []) {
    if (!isWavMarker(marker)) continue;
    markerCount += 1;
    const labelPayloadLength = 4 + utf8ByteLength(marker.name) + 1;
    labelsLength += 8 + labelPayloadLength + (labelPayloadLength & 1);
  }
  if (markerCount === 0) return 0;
  const cuePayloadLength = 4 + markerCount * 24;
  const cueLength = 8 + cuePayloadLength + (cuePayloadLength & 1);
  const adtlPayloadLength = 4 + labelsLength;
  const listLength = 8 + adtlPayloadLength + (adtlPayloadLength & 1);
  return cueLength + listLength;
}

/**
 * Returns the byte length of a WAV header before allocating it.
 *
 * The data payload is excluded; the result includes `fmt`, optional `fact`,
 * optional BWF metadata, and the `data` chunk header.
 */
export function wavHeaderByteLength(
  frames: number,
  numChannels: number,
  bitDepth: WavBitDepth,
  metadata: AudioFileMetadata | undefined,
): number {
  const layout = wavLayout(frames, numChannels, bitDepth);
  return (
    layout.fileSize - layout.dataSize - layout.dataPad + wavLeadingMetadataByteLength(metadata)
  );
}

/** Returns the chunks written after a WAV data payload (cue/list labels). */
export function wavTrailingMetadata(metadata: AudioFileMetadata | undefined): Uint8Array {
  const length = wavTrailingMetadataByteLength(metadata);
  if (length === 0) return new Uint8Array();

  // Build directly in the final output allocation. Streaming export keeps
  // this buffer accounted for while publishing, so intermediate cue/list and
  // label allocations would otherwise escape its memory meter.
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  const markers = metadata?.markers ?? [];
  let markerCount = 0;
  let labelsLength = 0;
  for (const marker of markers) {
    if (!isWavMarker(marker)) continue;
    markerCount += 1;
    const payloadLength = 4 + utf8ByteLength(marker.name) + 1;
    labelsLength += 8 + payloadLength + (payloadLength & 1);
  }

  const cuePayloadLength = 4 + markerCount * 24;
  const cueLength = 8 + cuePayloadLength + (cuePayloadLength & 1);
  writeTag(view, 0, 'cue ');
  view.setUint32(4, cuePayloadLength, true);
  view.setUint32(8, markerCount, true);

  let markerIndex = 0;
  let labelOffset = cueLength + 12;
  for (const marker of markers) {
    if (!isWavMarker(marker)) continue;
    const cueOffset = 12 + markerIndex * 24;
    view.setUint32(cueOffset, markerIndex + 1, true);
    view.setUint32(cueOffset + 4, marker.sampleOffset, true);
    writeTag(view, cueOffset + 8, 'data');
    view.setUint32(cueOffset + 20, marker.sampleOffset, true);

    const labelLength = utf8ByteLength(marker.name);
    const labelPayloadLength = 4 + labelLength + 1;
    writeTag(view, labelOffset, 'labl');
    view.setUint32(labelOffset + 4, labelPayloadLength, true);
    view.setUint32(labelOffset + 8, markerIndex + 1, true);
    const written = new TextEncoder().encodeInto(
      marker.name,
      out.subarray(labelOffset + 12, labelOffset + 12 + labelLength),
    );
    if (written.written !== labelLength || written.read !== marker.name.length) {
      throw new Error('Could not encode a WAV cue label');
    }
    labelOffset += 8 + labelPayloadLength + (labelPayloadLength & 1);
    markerIndex += 1;
  }
  writeTag(view, cueLength, 'LIST');
  view.setUint32(cueLength + 4, 4 + labelsLength, true);
  writeTag(view, cueLength + 8, 'adtl');
  return out;
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
  const header = new Uint8Array(
    wavHeaderByteLength(frames, numChannels, bitDepth, options.metadata),
  );
  const view = new DataView(header.buffer);
  const isFloat = bitDepth === '32f';
  let offset = 0;
  writeTag(view, offset, 'RIFF');
  view.setUint32(
    offset + 4,
    layout.riffSize +
      wavLeadingMetadataByteLength(options.metadata) +
      wavTrailingMetadataByteLength(options.metadata),
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
  offset = writeBext(view, offset, options.metadata);
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
  const header = wavHeader(frames, numChannels, sampleRate, bitDepth, options);
  const trailing = wavTrailingMetadata(options.metadata);
  const out = new Uint8Array(header.length + layout.dataSize + layout.dataPad + trailing.length);
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
  out.set(trailing, offset + layout.dataPad);
  return out;
}
