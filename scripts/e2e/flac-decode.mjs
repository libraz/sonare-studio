/**
 * FLAC decoder for checking exported files in node, written from the format
 * specification rather than from the app's encoder so the two cannot share a
 * mistake: STREAMINFO, fixed and variable blocking, every subframe type
 * (constant, verbatim, fixed, LPC, wasted bits), Rice partitions with escape
 * codes, and the three stereo decorrelation modes. Frame CRCs are not checked;
 * a corrupt frame shows up as wrong samples instead.
 */

class BitReader {
  constructor(bytes, offset) {
    this.bytes = bytes;
    this.pos = offset * 8;
  }

  /** Unsigned read of up to 32 bits, most significant first. */
  bits(count) {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.bytes[this.pos >>> 3];
      if (byte === undefined) throw new Error('FLAC stream ends inside a frame');
      value = value * 2 + ((byte >>> (7 - (this.pos & 7))) & 1);
      this.pos += 1;
    }
    return value;
  }

  signed(count) {
    if (count === 0) return 0;
    const value = this.bits(count);
    return value >= 2 ** (count - 1) ? value - 2 ** count : value;
  }

  unary() {
    let zeros = 0;
    while (this.bits(1) === 0) zeros += 1;
    return zeros;
  }

  align() {
    this.pos = Math.ceil(this.pos / 8) * 8;
  }

  get byteOffset() {
    return this.pos >>> 3;
  }
}

const BLOCK_SIZES = [
  0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768,
];
const SAMPLE_RATES = [
  0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000,
];
const SAMPLE_SIZES = [0, 8, 12, 0, 16, 20, 24, 32];
const FIXED_COEFFICIENTS = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];

function readResidual(reader, blockSize, order, out) {
  const method = reader.bits(2);
  if (method > 1) throw new Error(`reserved FLAC residual method ${method}`);
  const parameterBits = method === 0 ? 4 : 5;
  const escapeCode = method === 0 ? 15 : 31;
  const partitionOrder = reader.bits(4);
  const partitions = 2 ** partitionOrder;
  let index = order;
  for (let p = 0; p < partitions; p++) {
    const count =
      (partitionOrder === 0 ? blockSize : blockSize / partitions) - (p === 0 ? order : 0);
    const parameter = reader.bits(parameterBits);
    if (parameter === escapeCode) {
      const width = reader.bits(5);
      for (let i = 0; i < count; i++) out[index++] = reader.signed(width);
    } else {
      for (let i = 0; i < count; i++) {
        const folded = reader.unary() * 2 ** parameter + reader.bits(parameter);
        out[index++] = folded % 2 === 0 ? folded / 2 : -(folded + 1) / 2;
      }
    }
  }
}

function predict(out, order, coefficients, shift) {
  for (let i = order; i < out.length; i++) {
    let sum = 0;
    for (let j = 0; j < order; j++) sum += coefficients[j] * out[i - 1 - j];
    out[i] += Math.floor(sum / 2 ** shift);
  }
}

function readSubframe(reader, blockSize, bitsPerSample) {
  if (reader.bits(1) !== 0) throw new Error('FLAC subframe padding bit is set');
  const type = reader.bits(6);
  let wasted = 0;
  if (reader.bits(1) === 1) wasted = reader.unary() + 1;
  const bps = bitsPerSample - wasted;
  const out = new Array(blockSize).fill(0);
  if (type === 0) {
    out.fill(reader.signed(bps));
  } else if (type === 1) {
    for (let i = 0; i < blockSize; i++) out[i] = reader.signed(bps);
  } else if (type >= 8 && type <= 12) {
    const order = type - 8;
    for (let i = 0; i < order; i++) out[i] = reader.signed(bps);
    readResidual(reader, blockSize, order, out);
    predict(out, order, FIXED_COEFFICIENTS[order], 0);
  } else if (type >= 32) {
    const order = type - 31;
    for (let i = 0; i < order; i++) out[i] = reader.signed(bps);
    const precision = reader.bits(4) + 1;
    const shift = reader.signed(5);
    const coefficients = [];
    for (let i = 0; i < order; i++) coefficients.push(reader.signed(precision));
    readResidual(reader, blockSize, order, out);
    predict(out, order, coefficients, shift);
  } else {
    throw new Error(`reserved FLAC subframe type ${type}`);
  }
  if (wasted > 0) for (let i = 0; i < blockSize; i++) out[i] *= 2 ** wasted;
  return out;
}

/**
 * @param bytes A whole FLAC file.
 * @returns Planar float channels scaled to [-1, 1), the sample rate, the bit
 *   depth and STREAMINFO's total sample count.
 */
export function decodeFlac(bytes) {
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'fLaC') throw new Error('not a FLAC file');
  let offset = 4;
  let info = null;
  for (let last = false; !last; ) {
    const reader = new BitReader(bytes, offset);
    last = reader.bits(1) === 1;
    const type = reader.bits(7);
    const length = reader.bits(24);
    if (type === 0) {
      reader.bits(16 + 16 + 24 + 24);
      info = {
        sampleRate: reader.bits(20),
        channels: reader.bits(3) + 1,
        bitsPerSample: reader.bits(5) + 1,
        totalSamples: reader.bits(4) * 2 ** 32 + reader.bits(32),
      };
    }
    offset += 4 + length;
  }
  if (!info) throw new Error('FLAC file has no STREAMINFO');

  const planes = Array.from({ length: info.channels }, () => []);
  while (offset + 2 <= bytes.length) {
    const reader = new BitReader(bytes, offset);
    if (reader.bits(14) !== 0x3ffe) throw new Error(`lost FLAC frame sync at byte ${offset}`);
    reader.bits(2);
    const blockCode = reader.bits(4);
    const rateCode = reader.bits(4);
    const assignment = reader.bits(4);
    const sizeCode = reader.bits(3);
    reader.bits(1);
    // UTF-8-style coded frame or sample number.
    const lead = reader.bits(8);
    let continuation = 0;
    for (let mask = 0x80; lead & mask && mask > 1; mask >>= 1) continuation += 1;
    reader.bits(8 * Math.max(0, continuation - 1));
    let blockSize = BLOCK_SIZES[blockCode];
    if (blockCode === 1) blockSize = 192;
    else if (blockCode === 6) blockSize = reader.bits(8) + 1;
    else if (blockCode === 7) blockSize = reader.bits(16) + 1;
    if (rateCode === 12) reader.bits(8);
    else if (rateCode === 13 || rateCode === 14) reader.bits(16);
    else if (rateCode !== 0 && SAMPLE_RATES[rateCode] !== info.sampleRate) {
      throw new Error(`FLAC frame rate ${SAMPLE_RATES[rateCode]} differs from STREAMINFO`);
    }
    const bitsPerSample = sizeCode === 0 ? info.bitsPerSample : SAMPLE_SIZES[sizeCode];
    reader.bits(8);

    const channelCount = assignment < 8 ? assignment + 1 : 2;
    const decoded = [];
    for (let channel = 0; channel < channelCount; channel++) {
      const side =
        (assignment === 8 && channel === 1) ||
        (assignment === 9 && channel === 0) ||
        (assignment === 10 && channel === 1);
      decoded.push(readSubframe(reader, blockSize, bitsPerSample + (side ? 1 : 0)));
    }
    if (assignment === 8) {
      for (let i = 0; i < blockSize; i++) decoded[1][i] = decoded[0][i] - decoded[1][i];
    } else if (assignment === 9) {
      for (let i = 0; i < blockSize; i++) decoded[0][i] += decoded[1][i];
    } else if (assignment === 10) {
      for (let i = 0; i < blockSize; i++) {
        const mid = decoded[0][i] * 2 + (decoded[1][i] & 1);
        decoded[0][i] = (mid + decoded[1][i]) / 2;
        decoded[1][i] = (mid - decoded[1][i]) / 2;
      }
    }
    decoded.forEach((samples, channel) => {
      for (const sample of samples) planes[channel].push(sample);
    });
    reader.align();
    reader.bits(16);
    offset = reader.byteOffset;
  }
  const scale = 2 ** (info.bitsPerSample - 1);
  return {
    channels: planes.map((plane) => Float32Array.from(plane, (sample) => sample / scale)),
    sampleRate: info.sampleRate,
    bitsPerSample: info.bitsPerSample,
    totalSamples: info.totalSamples,
  };
}
