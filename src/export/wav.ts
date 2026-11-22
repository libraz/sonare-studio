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
import { PRODUCER_NAME } from './constants';
import { pcmFullScale, quantizePcmSample, tpdfDitherLsb } from './pcm-quantize';
import { assertPlanarChannels } from './planar-channels';

/** Output sample format: integer bit depth, or '32f' for IEEE float. */
export type WavBitDepth = 16 | 24 | '32f';

/** Options for {@link encodeWav}. */
export interface EncodeWavOptions {
  /** Output sample format (default 16). */
  bitDepth?: WavBitDepth;
  /** Apply TPDF dither before 16-bit quantization (default false; ignored for 24/'32f'). */
  dither?: boolean;
  /** Uniform [0, 1) noise source overriding the default frame-keyed TPDF dither (tests). */
  random?: () => number;
  /** BWF/cue metadata for a rendered delivery. Omitted for plain asset WAVs. */
  metadata?: AudioFileMetadata;
}

/** Bytes per sample for each supported format. */
function bytesPerSample(bitDepth: WavBitDepth): number {
  return bitDepth === '32f' ? 4 : bitDepth / 8;
}

const PCM16_FULL_SCALE = pcmFullScale(16);
const PCM24_FULL_SCALE = pcmFullScale(24);

/** Largest value representable by a classic RIFF/WAVE 32-bit chunk-size field. */
export const WAV_RIFF_SIZE_MAX = 0xffff_ffff;

/** Size of the BWF `bext` payload this writer emits. */
const BEXT_PAYLOAD_BYTES = 602;

/** `bext` payload plus its eight-byte RIFF chunk header. */
const BEXT_CHUNK_BYTES = 8 + BEXT_PAYLOAD_BYTES;

const WAV_SIZE_LIMIT_MESSAGE =
  'WAV exceeds the classic RIFF 4 GiB limit; shorten the range, lower the sample rate, or export stems.';

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
    throw new RangeError(WAV_SIZE_LIMIT_MESSAGE);
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
  view.setUint32(offset + 4, BEXT_PAYLOAD_BYTES, true);
  const payloadOffset = offset + 8;
  writeAscii(view, payloadOffset, metadata.title ?? '', 256);
  writeAscii(view, payloadOffset + 256, metadata.originator ?? PRODUCER_NAME, 32);
  writeAscii(view, payloadOffset + 288, metadata.originatorReference ?? '', 32);
  writeAscii(view, payloadOffset + 320, metadata.originationDate ?? '', 10);
  writeAscii(view, payloadOffset + 330, metadata.originationTime ?? '', 8);
  const reference = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, metadata.timeReference ?? 0));
  view.setUint32(payloadOffset + 338, reference >>> 0, true);
  view.setUint32(payloadOffset + 342, Math.floor(reference / 0x1_0000_0000), true);
  view.setUint16(payloadOffset + 346, 2, true); // BWF v2
  return offset + BEXT_CHUNK_BYTES;
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
  // The `bext` chunk is always emitted in full when metadata was requested,
  // even if every field is empty.
  return metadata === undefined ? 0 : BEXT_CHUNK_BYTES;
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
  const riffSize =
    layout.riffSize +
    wavLeadingMetadataByteLength(options.metadata) +
    wavTrailingMetadataByteLength(options.metadata);
  if (riffSize > WAV_RIFF_SIZE_MAX) throw new RangeError(WAV_SIZE_LIMIT_MESSAGE);
  view.setUint32(offset + 4, riffSize, true);
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

/** Interleaves `channels` into `out` at `offset` as little-endian samples; returns the end offset. */
function writeSamples(
  out: Uint8Array,
  offset: number,
  channels: ReadonlyArray<Float32Array>,
  bitDepth: WavBitDepth,
  options: EncodeWavOptions,
  frameOffset = 0,
): number {
  const frames = channels[0].length;
  const sampleBytes = bytesPerSample(bitDepth);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const dither = options.dither === true && bitDepth === 16;
  const random = options.random;
  let cursor = offset;
  for (let i = 0; i < frames; i++) {
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
      const sample = channels[channelIndex][i];
      if (bitDepth === '32f') view.setFloat32(cursor, Number.isFinite(sample) ? sample : 0, true);
      else if (bitDepth === 16) {
        view.setInt16(
          cursor,
          quantizePcmSample(
            sample,
            PCM16_FULL_SCALE.positiveMax,
            PCM16_FULL_SCALE.negativeMax,
            dither
              ? random
                ? random() - random()
                : tpdfDitherLsb(frameOffset + i, channelIndex)
              : 0,
          ),
          true,
        );
      } else {
        const value = quantizePcmSample(
          sample,
          PCM24_FULL_SCALE.positiveMax,
          PCM24_FULL_SCALE.negativeMax,
        );
        view.setUint8(cursor, value & 0xff);
        view.setUint8(cursor + 1, (value >> 8) & 0xff);
        view.setUint8(cursor + 2, (value >> 16) & 0xff);
      }
      cursor += sampleBytes;
    }
  }
  return cursor;
}

/**
 * Encodes a PCM block for a WAV stream (no RIFF header).
 *
 * @param frameOffset Absolute frame index of the block's first frame, so
 *   dither matches the whole-buffer encode.
 */
export function encodeWavChunk(
  channels: ReadonlyArray<Float32Array>,
  bitDepth: WavBitDepth,
  options: EncodeWavOptions = {},
  frameOffset = 0,
): Uint8Array {
  const frames = assertPlanarChannels(channels, 'WAV');
  const out = new Uint8Array(frames * channels.length * bytesPerSample(bitDepth));
  writeSamples(out, 0, channels, bitDepth, options, frameOffset);
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
  const frames = assertPlanarChannels(channels, 'WAV');

  const numChannels = channels.length;
  const layout = wavLayout(frames, numChannels, bitDepth);
  const header = wavHeader(frames, numChannels, sampleRate, bitDepth, options);
  const trailing = wavTrailingMetadata(options.metadata);
  const out = new Uint8Array(header.length + layout.dataSize + layout.dataPad + trailing.length);
  out.set(header);
  const offset = writeSamples(out, header.length, channels, bitDepth, options);
  // The optional pad byte is already zero-initialized.
  out.set(trailing, offset + layout.dataPad);
  return out;
}
