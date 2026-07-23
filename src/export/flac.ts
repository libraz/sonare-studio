/**
 * Minimal deterministic FLAC encoder.
 *
 * This dependency-free writer emits proper FLAC STREAMINFO, frame CRCs and
 * per-subframe lossless coding. It chooses the smaller of verbatim subframes
 * and FLAC fixed-predictor subframes with Rice-coded residuals for each
 * channel/frame. It intentionally stops short of general LPC analysis, but
 * covers the common low-order predictor path without adding deployment assets.
 */

import {
  type AudioEncodeOptions,
  type AudioEncoder,
  listEncoders,
  registerEncoder,
} from './codecs';
import { quantizePcmSample } from './pcm-quantize';

export const FLAC_ENCODER_ID = 'flac';

export type FlacBitDepth = 16 | 24;

export interface EncodeFlacOptions {
  /** Integer PCM bit depth stored in FLAC subframes (default 24). */
  bitDepth?: FlacBitDepth;
  /** Apply deterministic TPDF dither before 16-bit quantization (default false). */
  dither?: boolean;
  /** Samples per FLAC frame; clamped by validation to [16, 65535] (default 4096). */
  blockSize?: number;
}

const DEFAULT_FLAC_BIT_DEPTH: FlacBitDepth = 24;
const DEFAULT_BLOCK_SIZE = 4096;
const FLAC_MIN_BLOCK_SIZE = 16;
const FLAC_MAX_BLOCK_SIZE = 65535;
const LPC_QLP_PRECISION = 15;
const LPC_QLP_SHIFT = 12;

class BitWriter {
  private readonly bytes: number[] = [];
  private current = 0;
  private bitCount = 0;

  writeBits(value: number | bigint, count: number): void {
    const big = BigInt(value);
    for (let bit = count - 1; bit >= 0; bit -= 1) {
      this.current = (this.current << 1) | Number((big >> BigInt(bit)) & 1n);
      this.bitCount += 1;
      if (this.bitCount === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.bitCount = 0;
      }
    }
  }

  writeByte(value: number): void {
    if (this.bitCount !== 0) throw new Error('Byte writes require byte alignment');
    this.bytes.push(value & 0xff);
  }

  writeBytes(values: Uint8Array | readonly number[]): void {
    if (this.bitCount !== 0) throw new Error('Byte writes require byte alignment');
    for (const value of values) this.bytes.push(value & 0xff);
  }

  alignZero(): void {
    if (this.bitCount === 0) return;
    this.bytes.push(this.current << (8 - this.bitCount));
    this.current = 0;
    this.bitCount = 0;
  }

  toUint8Array(): Uint8Array {
    if (this.bitCount !== 0) this.alignZero();
    return new Uint8Array(this.bytes);
  }
}

class Md5 {
  private readonly state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  private readonly buffer = new Uint8Array(64);
  private bufferLength = 0;
  private lengthBytes = 0;

  updateByte(value: number): void {
    this.buffer[this.bufferLength] = value & 0xff;
    this.bufferLength += 1;
    this.lengthBytes += 1;
    if (this.bufferLength === 64) {
      this.processBlock(this.buffer);
      this.bufferLength = 0;
    }
  }

  digest(): Uint8Array {
    const bitLength = this.lengthBytes * 8;
    this.updateByte(0x80);
    while (this.bufferLength !== 56) this.updateByte(0);
    const low = bitLength >>> 0;
    const high = Math.floor(bitLength / 0x100000000) >>> 0;
    for (let index = 0; index < 4; index += 1) this.updateByte(low >>> (index * 8));
    for (let index = 0; index < 4; index += 1) this.updateByte(high >>> (index * 8));

    const out = new Uint8Array(16);
    for (let word = 0; word < 4; word += 1) {
      const value = this.state[word];
      out[word * 4] = value & 0xff;
      out[word * 4 + 1] = (value >>> 8) & 0xff;
      out[word * 4 + 2] = (value >>> 16) & 0xff;
      out[word * 4 + 3] = (value >>> 24) & 0xff;
    }
    return out;
  }

  private processBlock(block: Uint8Array): void {
    const words = new Uint32Array(16);
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4;
      words[index] =
        block[offset] |
        (block[offset + 1] << 8) |
        (block[offset + 2] << 16) |
        (block[offset + 3] << 24);
    }

    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      const next = d;
      d = c;
      c = b;
      b = (b + rotateLeft((a + f + MD5_K[index] + words[g]) >>> 0, MD5_S[index])) >>> 0;
      a = next;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
  }
}

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

const MD5_K = Uint32Array.from({ length: 64 }, (_, index) =>
  Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000),
);

function rotateLeft(value: number, count: number): number {
  return ((value << count) | (value >>> (32 - count))) >>> 0;
}

function assertPlanar(channels: ReadonlyArray<Float32Array>): number {
  if (channels.length < 1 || channels.length > 8) {
    throw new RangeError(`FLAC encoding supports 1 to 8 channels, got ${channels.length}`);
  }
  const frames = channels[0].length;
  if (channels.some((channel) => channel.length !== frames)) {
    throw new RangeError('FLAC channel buffers must have equal lengths');
  }
  return frames;
}

function chooseBlockSize(frames: number, requestedBlockSize: number): number {
  if (frames === 0) return requestedBlockSize;
  if (frames < FLAC_MIN_BLOCK_SIZE) {
    throw new RangeError(
      `FLAC encoding requires at least ${FLAC_MIN_BLOCK_SIZE} samples or empty input, got ${frames}`,
    );
  }
  if (frames <= requestedBlockSize) return frames;
  const shortFinalBlockSize = frames % requestedBlockSize;
  if (shortFinalBlockSize === 0 || shortFinalBlockSize >= FLAC_MIN_BLOCK_SIZE) {
    return requestedBlockSize;
  }
  for (let candidate = requestedBlockSize - 1; candidate >= FLAC_MIN_BLOCK_SIZE; candidate -= 1) {
    const remainder = frames % candidate;
    if (remainder === 0 || remainder >= FLAC_MIN_BLOCK_SIZE) return candidate;
  }
  return requestedBlockSize;
}

function crc8(bytes: Uint8Array | readonly number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte & 0xff;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function crc16(bytes: Uint8Array | readonly number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= (byte & 0xff) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function writeUint24(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 16) & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
  out[offset + 2] = value & 0xff;
}

function utf8Uint(value: number): number[] {
  if (!Number.isInteger(value) || value < 0)
    throw new RangeError(`Bad FLAC frame number: ${value}`);
  if (value < 0x80) return [value];
  if (value < 0x800) return [0xc0 | (value >> 6), 0x80 | (value & 0x3f)];
  if (value < 0x10000) {
    return [0xe0 | (value >> 12), 0x80 | ((value >> 6) & 0x3f), 0x80 | (value & 0x3f)];
  }
  if (value < 0x200000) {
    return [
      0xf0 | (value >> 18),
      0x80 | ((value >> 12) & 0x3f),
      0x80 | ((value >> 6) & 0x3f),
      0x80 | (value & 0x3f),
    ];
  }
  throw new RangeError(`FLAC frame number too large: ${value}`);
}

function quantizeSample(sample: number, bitDepth: FlacBitDepth, ditherLsb = 0): number {
  const positiveMax = bitDepth === 16 ? 0x7fff : 0x7fffff;
  const negativeMax = bitDepth === 16 ? 0x8000 : 0x800000;
  return quantizePcmSample(sample, positiveMax, negativeMax, ditherLsb);
}

/**
 * A stateless TPDF source keeps FLAC dither reproducible without retaining a
 * second quantized PCM buffer merely to make STREAMINFO's MD5 match frames.
 */
function ditherUnit(index: number, salt: number): number {
  let value = (index + salt) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x100000000;
}

function tpdfDitherLsb(frame: number, channel: number): number {
  const index = frame * 31 + channel;
  return ditherUnit(index, 0x9e3779b9) - ditherUnit(index, 0x85ebca6b);
}

function writeSigned(writer: BitWriter, value: number, bits: number): void {
  const unsigned = value < 0 ? (1 << bits) + value : value;
  writer.writeBits(unsigned, bits);
}

function foldResidual(value: number): number {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

function writeRiceSigned(writer: BitWriter, residual: number, riceParam: number): void {
  const folded = foldResidual(residual);
  const quotient = folded >>> riceParam;
  for (let bit = 0; bit < quotient; bit += 1) writer.writeBits(0, 1);
  writer.writeBits(1, 1);
  if (riceParam > 0) writer.writeBits(folded & ((1 << riceParam) - 1), riceParam);
}

function pcmMd5(
  channels: ReadonlyArray<Float32Array>,
  frames: number,
  bitDepth: FlacBitDepth,
  dither: boolean,
): Uint8Array {
  const md5 = new Md5();
  const bytesPerSample = bitDepth / 8;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const sample = quantizeSample(
        channels[channelIndex][frame],
        bitDepth,
        dither ? tpdfDitherLsb(frame, channelIndex) : 0,
      );
      const unsigned = sample < 0 ? 2 ** bitDepth + sample : sample;
      for (let byte = 0; byte < bytesPerSample; byte += 1) {
        md5.updateByte(unsigned >>> (byte * 8));
      }
    }
  }
  return md5.digest();
}

function streamInfo(
  frames: number,
  sampleRate: number,
  channels: number,
  bitDepth: FlacBitDepth,
  blockSize: number,
  md5: Uint8Array,
  minFrameSize: number,
  maxFrameSize: number,
): Uint8Array {
  const body = new Uint8Array(34);
  const minBlockSize =
    frames === 0 ? blockSize : Math.min(blockSize, Math.max(FLAC_MIN_BLOCK_SIZE, frames));
  body[0] = (minBlockSize >>> 8) & 0xff;
  body[1] = minBlockSize & 0xff;
  body[2] = (blockSize >>> 8) & 0xff;
  body[3] = blockSize & 0xff;
  writeUint24(body, 4, minFrameSize);
  writeUint24(body, 7, maxFrameSize);

  const packed =
    (BigInt(sampleRate) << 44n) |
    (BigInt(channels - 1) << 41n) |
    (BigInt(bitDepth - 1) << 36n) |
    BigInt(frames);
  for (let index = 0; index < 8; index += 1) {
    body[10 + index] = Number((packed >> BigInt((7 - index) * 8)) & 0xffn);
  }
  body.set(md5, 18);
  return body;
}

function frameHeader(frameNumber: number, blockSize: number, channels: number): Uint8Array {
  const writer = new BitWriter();
  writer.writeBits(0x3ffe, 14);
  writer.writeBits(0, 1); // reserved
  writer.writeBits(0, 1); // fixed-blocksize stream
  writer.writeBits(7, 4); // block size follows as 16-bit (blockSize - 1)
  writer.writeBits(0, 4); // sample rate from STREAMINFO
  writer.writeBits(channels - 1, 4); // independent channels
  writer.writeBits(0, 3); // bits per sample from STREAMINFO
  writer.writeBits(0, 1); // reserved
  writer.writeBytes(utf8Uint(frameNumber));
  writer.writeBits(blockSize - 1, 16);
  const withoutCrc = writer.toUint8Array();
  const header = new Uint8Array(withoutCrc.length + 1);
  header.set(withoutCrc);
  header[header.length - 1] = crc8(withoutCrc);
  return header;
}

function quantizeBlock(
  channel: Float32Array,
  channelIndex: number,
  offset: number,
  blockSize: number,
  bitDepth: FlacBitDepth,
  dither: boolean,
): number[] {
  const samples: number[] = [];
  for (let index = 0; index < blockSize; index += 1) {
    samples.push(
      quantizeSample(
        channel[offset + index],
        bitDepth,
        dither ? tpdfDitherLsb(offset + index, channelIndex) : 0,
      ),
    );
  }
  return samples;
}

function fixedPrediction(samples: readonly number[], index: number, order: number): number {
  switch (order) {
    case 0:
      return 0;
    case 1:
      return samples[index - 1];
    case 2:
      return 2 * samples[index - 1] - samples[index - 2];
    case 3:
      return 3 * samples[index - 1] - 3 * samples[index - 2] + samples[index - 3];
    case 4:
      return (
        4 * samples[index - 1] -
        6 * samples[index - 2] +
        4 * samples[index - 3] -
        samples[index - 4]
      );
    default:
      throw new RangeError(`Unsupported FLAC fixed predictor order: ${order}`);
  }
}

function residualsForFixedOrder(samples: readonly number[], order: number): number[] {
  const residuals: number[] = [];
  for (let index = order; index < samples.length; index += 1) {
    residuals.push(samples[index] - fixedPrediction(samples, index, order));
  }
  return residuals;
}

function autocorrelation(samples: readonly number[], lag: number): number {
  let sum = 0;
  for (let index = lag; index < samples.length; index += 1) {
    sum += samples[index] * samples[index - lag];
  }
  return sum;
}

function lpcCoefficients(samples: readonly number[], order: number): number[] | null {
  const autocorrelations = Array.from({ length: order + 1 }, (_, lag) =>
    autocorrelation(samples, lag),
  );
  let error = autocorrelations[0];
  if (error <= 0) return null;

  let coefficients: number[] = [];
  for (let currentOrder = 1; currentOrder <= order; currentOrder += 1) {
    let numerator = autocorrelations[currentOrder];
    for (let index = 1; index < currentOrder; index += 1) {
      numerator -= coefficients[index - 1] * autocorrelations[currentOrder - index];
    }
    const reflection = numerator / error;
    if (!Number.isFinite(reflection) || Math.abs(reflection) >= 1) return null;

    const next = coefficients.slice();
    for (let index = 0; index < currentOrder - 1; index += 1) {
      next[index] = coefficients[index] - reflection * coefficients[currentOrder - 2 - index];
    }
    next[currentOrder - 1] = reflection;
    coefficients = next;
    error *= 1 - reflection * reflection;
    if (!Number.isFinite(error) || error <= 1e-9) return null;
  }
  return coefficients;
}

function quantizeLpcCoefficients(coefficients: readonly number[]): number[] | null {
  const scale = 2 ** LPC_QLP_SHIFT;
  const limit = 2 ** (LPC_QLP_PRECISION - 1);
  const quantized = coefficients.map((coefficient) => Math.round(coefficient * scale));
  if (quantized.some((coefficient) => !Number.isFinite(coefficient))) return null;
  if (quantized.every((coefficient) => coefficient === 0)) return null;
  if (quantized.some((coefficient) => coefficient < -limit || coefficient >= limit)) return null;
  return quantized;
}

function lpcPrediction(
  samples: readonly number[],
  index: number,
  coefficients: readonly number[],
): number {
  let sum = 0;
  for (let coefficientIndex = 0; coefficientIndex < coefficients.length; coefficientIndex += 1) {
    sum += coefficients[coefficientIndex] * samples[index - coefficientIndex - 1];
  }
  return Math.floor(sum / 2 ** LPC_QLP_SHIFT);
}

function residualsForLpc(samples: readonly number[], coefficients: readonly number[]): number[] {
  const residuals: number[] = [];
  for (let index = coefficients.length; index < samples.length; index += 1) {
    residuals.push(samples[index] - lpcPrediction(samples, index, coefficients));
  }
  return residuals;
}

function riceBits(residuals: readonly number[], riceParam: number): number {
  let bits = 0;
  for (const residual of residuals) {
    const folded = foldResidual(residual);
    bits += (folded >>> riceParam) + 1 + riceParam;
  }
  return bits;
}

function chooseRiceParam(residuals: readonly number[]): { param: number; bits: number } {
  let bestParam = 0;
  let bestBits = Number.POSITIVE_INFINITY;
  for (let param = 0; param <= 14; param += 1) {
    const bits = riceBits(residuals, param);
    if (bits < bestBits) {
      bestBits = bits;
      bestParam = param;
    }
  }
  return { param: bestParam, bits: bestBits };
}

interface RicePartition {
  readonly param: number;
  readonly residuals: readonly number[];
}

interface RicePlan {
  readonly order: number;
  readonly partitions: readonly RicePartition[];
  readonly bits: number;
}

function chooseRicePlan(
  residuals: readonly number[],
  blockSize: number,
  predictorOrder: number,
): RicePlan {
  const singlePartition = chooseRiceParam(residuals);
  let best: RicePlan = {
    order: 0,
    partitions: [{ param: singlePartition.param, residuals }],
    bits: 4 + 4 + singlePartition.bits,
  };
  for (let partitionOrder = 1; partitionOrder <= 4; partitionOrder += 1) {
    const partitionCount = 1 << partitionOrder;
    if (blockSize % partitionCount !== 0) continue;
    const partitionSamples = blockSize / partitionCount;
    if (partitionSamples <= predictorOrder) continue;
    const partitions: RicePartition[] = [];
    let cursor = 0;
    let residualBits = 0;
    for (let partition = 0; partition < partitionCount; partition += 1) {
      const count = partition === 0 ? partitionSamples - predictorOrder : partitionSamples;
      const partResiduals = residuals.slice(cursor, cursor + count);
      cursor += count;
      const rice = chooseRiceParam(partResiduals);
      partitions.push({ param: rice.param, residuals: partResiduals });
      residualBits += 4 + rice.bits;
    }
    if (cursor !== residuals.length) continue;
    const bits = 4 + residualBits;
    if (bits < best.bits) best = { order: partitionOrder, partitions, bits };
  }
  return best;
}

interface FixedSubframePlan {
  readonly kind: 'fixed';
  readonly order: number;
  readonly rice: RicePlan;
  readonly bits: number;
}

interface LpcSubframePlan {
  readonly kind: 'lpc';
  readonly coefficients: readonly number[];
  readonly rice: RicePlan;
  readonly bits: number;
}

interface ConstantSubframePlan {
  readonly kind: 'constant';
  readonly bits: number;
}

interface VerbatimSubframePlan {
  readonly kind: 'verbatim';
  readonly bits: number;
}

type SubframePlan =
  | ConstantSubframePlan
  | FixedSubframePlan
  | LpcSubframePlan
  | VerbatimSubframePlan;

function isConstantBlock(samples: readonly number[]): boolean {
  const first = samples[0];
  return samples.every((sample) => sample === first);
}

function chooseSubframePlan(samples: readonly number[], bitDepth: FlacBitDepth): SubframePlan {
  const verbatimBits = 8 + samples.length * bitDepth;
  let best: SubframePlan = isConstantBlock(samples)
    ? { kind: 'constant', bits: 8 + bitDepth }
    : { kind: 'verbatim', bits: verbatimBits };
  const maxOrder = Math.min(4, samples.length - 1);
  for (let order = 0; order <= maxOrder; order += 1) {
    const residuals = residualsForFixedOrder(samples, order);
    const rice = chooseRicePlan(residuals, samples.length, order);
    const bits = 8 + order * bitDepth + 2 + rice.bits;
    if (bits < best.bits) {
      best = { kind: 'fixed', order, rice, bits };
    }
  }
  const maxLpcOrder = Math.min(8, samples.length - 1);
  for (let order = 1; order <= maxLpcOrder; order += 1) {
    const floatingCoefficients = lpcCoefficients(samples, order);
    if (!floatingCoefficients) continue;
    const coefficients = quantizeLpcCoefficients(floatingCoefficients);
    if (!coefficients) continue;
    const residuals = residualsForLpc(samples, coefficients);
    const rice = chooseRicePlan(residuals, samples.length, order);
    const bits = 8 + order * bitDepth + 4 + 5 + order * LPC_QLP_PRECISION + 2 + rice.bits;
    if (bits < best.bits) {
      best = { kind: 'lpc', coefficients, rice, bits };
    }
  }
  return best;
}

function writeConstantSubframe(
  writer: BitWriter,
  samples: readonly number[],
  bitDepth: FlacBitDepth,
): void {
  writer.writeBits(0, 1); // zero padding bit
  writer.writeBits(0, 6); // constant subframe
  writer.writeBits(0, 1); // no wasted bits-per-sample
  writeSigned(writer, samples[0], bitDepth);
}

function writeVerbatimSubframe(
  writer: BitWriter,
  samples: readonly number[],
  bitDepth: FlacBitDepth,
): void {
  writer.writeBits(0, 1); // zero padding bit
  writer.writeBits(1, 6); // verbatim subframe
  writer.writeBits(0, 1); // no wasted bits-per-sample
  for (const sample of samples) writeSigned(writer, sample, bitDepth);
}

function writeRicePlan(writer: BitWriter, plan: RicePlan): void {
  writer.writeBits(0, 2); // Rice coding with 4-bit parameters
  writer.writeBits(plan.order, 4);
  for (const partition of plan.partitions) {
    writer.writeBits(partition.param, 4);
    for (const residual of partition.residuals) writeRiceSigned(writer, residual, partition.param);
  }
}

function writeFixedSubframe(
  writer: BitWriter,
  samples: readonly number[],
  bitDepth: FlacBitDepth,
  plan: FixedSubframePlan,
): void {
  writer.writeBits(0, 1); // zero padding bit
  writer.writeBits(0b001000 | plan.order, 6); // fixed predictor subframe
  writer.writeBits(0, 1); // no wasted bits-per-sample
  for (let index = 0; index < plan.order; index += 1) writeSigned(writer, samples[index], bitDepth);
  writeRicePlan(writer, plan.rice);
}

function writeLpcSubframe(
  writer: BitWriter,
  samples: readonly number[],
  bitDepth: FlacBitDepth,
  plan: LpcSubframePlan,
): void {
  writer.writeBits(0, 1); // zero padding bit
  writer.writeBits(0b100000 | (plan.coefficients.length - 1), 6); // LPC predictor subframe
  writer.writeBits(0, 1); // no wasted bits-per-sample
  for (let index = 0; index < plan.coefficients.length; index += 1) {
    writeSigned(writer, samples[index], bitDepth);
  }
  writer.writeBits(LPC_QLP_PRECISION - 1, 4);
  writeSigned(writer, LPC_QLP_SHIFT, 5);
  for (const coefficient of plan.coefficients) {
    writeSigned(writer, coefficient, LPC_QLP_PRECISION);
  }
  writeRicePlan(writer, plan.rice);
}

function writeBestSubframe(
  writer: BitWriter,
  samples: readonly number[],
  bitDepth: FlacBitDepth,
): void {
  const plan = chooseSubframePlan(samples, bitDepth);
  if (plan.kind === 'constant') {
    writeConstantSubframe(writer, samples, bitDepth);
  } else if (plan.kind === 'fixed') {
    writeFixedSubframe(writer, samples, bitDepth, plan);
  } else if (plan.kind === 'lpc') {
    writeLpcSubframe(writer, samples, bitDepth, plan);
  } else {
    writeVerbatimSubframe(writer, samples, bitDepth);
  }
}

function encodeFrame(
  channels: ReadonlyArray<Float32Array>,
  offset: number,
  blockSize: number,
  bitDepth: FlacBitDepth,
  dither: boolean,
  frameNumber: number,
): Uint8Array {
  const writer = new BitWriter();
  writer.writeBytes(frameHeader(frameNumber, blockSize, channels.length));
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
    writeBestSubframe(
      writer,
      quantizeBlock(channels[channelIndex], channelIndex, offset, blockSize, bitDepth, dither),
      bitDepth,
    );
  }
  writer.alignZero();
  const withoutFooter = writer.toUint8Array();
  const crc = crc16(withoutFooter);
  const out = new Uint8Array(withoutFooter.length + 2);
  out.set(withoutFooter);
  out[out.length - 2] = (crc >>> 8) & 0xff;
  out[out.length - 1] = crc & 0xff;
  return out;
}

/**
 * Reports encode progress as a fraction in [0, 1]. Called on frame boundaries
 * so a long lossless encode can drive a live progress bar instead of appearing
 * frozen at the render stage; the last call reports 1.
 */
export type FlacProgress = (fraction: number) => void;

export function encodeFlac(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  options: EncodeFlacOptions = {},
  onProgress?: FlacProgress,
): Uint8Array {
  const frames = assertPlanar(channels);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > 0xfffff) {
    throw new RangeError(`FLAC sample rate must be an integer in [1, 1048575], got ${sampleRate}`);
  }
  const bitDepth = options.bitDepth ?? DEFAULT_FLAC_BIT_DEPTH;
  if (bitDepth !== 16 && bitDepth !== 24) {
    throw new RangeError(`Unsupported FLAC bit depth: ${String(bitDepth)}`);
  }
  const dither = options.dither === true && bitDepth === 16;
  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  if (
    !Number.isInteger(blockSize) ||
    blockSize < FLAC_MIN_BLOCK_SIZE ||
    blockSize > FLAC_MAX_BLOCK_SIZE
  ) {
    throw new RangeError(
      `FLAC block size must be an integer in [${FLAC_MIN_BLOCK_SIZE}, ${FLAC_MAX_BLOCK_SIZE}], got ${String(blockSize)}`,
    );
  }
  if (frames > Number(0xfffffffffn)) {
    throw new RangeError(`FLAC total sample count exceeds 36 bits: ${frames}`);
  }
  const effectiveBlockSize = chooseBlockSize(frames, blockSize);

  const encodedFrames: Uint8Array[] = [];
  let minFrameSize = 0;
  let maxFrameSize = 0;
  let frameNumber = 0;
  const totalBlocks = frames === 0 ? 0 : Math.ceil(frames / effectiveBlockSize);
  // Throttle progress to ~100 updates so a many-thousand-block encode does not
  // flood the caller (or the worker message channel) with per-frame ticks.
  const progressStride = totalBlocks > 0 ? Math.max(1, Math.floor(totalBlocks / 100)) : 0;
  for (let offset = 0; offset < frames; offset += effectiveBlockSize) {
    const size = Math.min(effectiveBlockSize, frames - offset);
    const frame = encodeFrame(channels, offset, size, bitDepth, dither, frameNumber);
    encodedFrames.push(frame);
    minFrameSize = minFrameSize === 0 ? frame.length : Math.min(minFrameSize, frame.length);
    maxFrameSize = Math.max(maxFrameSize, frame.length);
    frameNumber += 1;
    if (onProgress && (frameNumber % progressStride === 0 || frameNumber === totalBlocks)) {
      onProgress(frameNumber / totalBlocks);
    }
  }
  // Always resolve to a full bar, even for empty input where the loop never ran.
  onProgress?.(1);

  const signature = new Uint8Array([0x66, 0x4c, 0x61, 0x43]); // fLaC
  const info = streamInfo(
    frames,
    sampleRate,
    channels.length,
    bitDepth,
    effectiveBlockSize,
    pcmMd5(channels, frames, bitDepth, dither),
    minFrameSize,
    maxFrameSize,
  );
  const metadata = new Uint8Array(4 + info.length);
  metadata[0] = 0x80; // last metadata block, STREAMINFO
  writeUint24(metadata, 1, info.length);
  metadata.set(info, 4);
  const chunks = [signature, metadata, ...encodedFrames];

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

function toFlacOptions(options: AudioEncodeOptions = {}): EncodeFlacOptions {
  const out: EncodeFlacOptions = {};
  const bitDepth = options['bitDepth'];
  if (bitDepth === 16 || bitDepth === 24) out.bitDepth = bitDepth;
  if (options['dither'] === true) out.dither = true;
  const blockSize = options['blockSize'];
  if (typeof blockSize === 'number') out.blockSize = blockSize;
  return out;
}

export function createFlacEncoder(): AudioEncoder {
  return {
    id: FLAC_ENCODER_ID,
    label: 'FLAC (lossless)',
    extension: '.flac',
    mime: 'audio/flac',
    deterministic: true,
    encode: (channels, sampleRate, options) =>
      encodeFlac(channels, sampleRate, toFlacOptions(options)),
  };
}

export function registerFlacEncoder(): boolean {
  if (listEncoders().some((encoder) => encoder.id === FLAC_ENCODER_ID)) return false;
  registerEncoder(createFlacEncoder());
  return true;
}
