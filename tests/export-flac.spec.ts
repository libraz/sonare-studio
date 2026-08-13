import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getEncoder, listEncoders } from '@/export/codecs';
import { createFlacEncoder, encodeFlac, FLAC_ENCODER_ID, registerFlacEncoder } from '@/export/flac';

function u24(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function streamInfoPacked(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(bytes[18 + index]);
  }
  return value;
}

function streamInfoMd5(bytes: Uint8Array): Uint8Array {
  return bytes.slice(26, 42);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function metadataBlocks(
  bytes: Uint8Array,
): Array<{ type: number; last: boolean; offset: number; size: number }> {
  const blocks: Array<{ type: number; last: boolean; offset: number; size: number }> = [];
  for (let offset = 4; ; ) {
    const header = bytes[offset];
    const size = u24(bytes, offset + 1);
    blocks.push({ type: header & 0x7f, last: (header & 0x80) !== 0, offset: offset + 4, size });
    offset += 4 + size;
    if ((header & 0x80) !== 0) return blocks;
  }
}

function quantizeSample(sample: number, bitDepth: 16 | 24): number {
  const value = Math.min(1, Math.max(-1, sample));
  const positiveMax = bitDepth === 16 ? 0x7fff : 0x7fffff;
  const negativeMax = bitDepth === 16 ? 0x8000 : 0x800000;
  return Math.round(value < 0 ? value * negativeMax : value * positiveMax);
}

function expectedPcmMd5(channels: ReadonlyArray<Float32Array>, bitDepth: 16 | 24): string {
  const hash = createHash('md5');
  const bytesPerSample = bitDepth / 8;
  const scratch = Buffer.alloc(bytesPerSample);
  for (let frame = 0; frame < channels[0].length; frame += 1) {
    for (const channel of channels) {
      const sample = quantizeSample(channel[frame], bitDepth);
      const unsigned = sample < 0 ? 2 ** bitDepth + sample : sample;
      for (let byte = 0; byte < bytesPerSample; byte += 1) {
        scratch[byte] = (unsigned >>> (byte * 8)) & 0xff;
      }
      hash.update(scratch);
    }
  }
  return hash.digest('hex');
}

function arSignal(seed: number, length: number): Float32Array {
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const a1 = random() * 3.6 - 1.8;
  const a2 = random() * 1.8 - 0.9;
  let previous = (random() * 2 - 1) * 0.2;
  let beforePrevious = (random() * 2 - 1) * 0.2;
  return Float32Array.from({ length }, () => {
    const noise = (random() * 2 - 1) * 0.02;
    let sample = a1 * previous + a2 * beforePrevious + noise;
    if (!Number.isFinite(sample)) sample = 0;
    sample = Math.max(-0.9, Math.min(0.9, sample));
    beforePrevious = previous;
    previous = sample;
    return sample * 0.7;
  });
}

function highOrderArSignal(seed: number, length: number, order: number): Float32Array {
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const coefficients = Array.from(
    { length: order },
    (_, index) => (random() * 2 - 1) * (0.55 / (index + 1)),
  );
  let history = Array.from({ length: order }, () => random() * 0.2 - 0.1);
  return Float32Array.from({ length }, () => {
    let sample = (random() * 2 - 1) * 0.01;
    for (let index = 0; index < order; index += 1) sample += coefficients[index] * history[index];
    sample = Math.max(-0.9, Math.min(0.9, sample));
    history = [sample, ...history.slice(0, -1)];
    return sample * 0.8;
  });
}

describe('encodeFlac', () => {
  it('writes a FLAC stream with STREAMINFO and frames', () => {
    const left = new Float32Array(32);
    const right = new Float32Array(32);
    for (let index = 0; index < 32; index += 1) {
      left[index] = index % 2 === 0 ? 0.25 : -0.25;
      right[index] = index / 64;
    }

    const bytes = encodeFlac([left, right], 48000, { bitDepth: 16, blockSize: 16 });

    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('fLaC');
    expect(bytes[4]).toBe(0x80);
    expect(u24(bytes, 5)).toBe(34);
    expect(u16(bytes, 8)).toBe(16);
    expect(u16(bytes, 10)).toBe(16);
    const minFrameSize = u24(bytes, 12);
    const maxFrameSize = u24(bytes, 15);
    expect(minFrameSize).toBeGreaterThan(0);
    expect(maxFrameSize).toBeGreaterThanOrEqual(minFrameSize);

    const packed = streamInfoPacked(bytes);
    expect(Number((packed >> 44n) & 0xfffffn)).toBe(48000);
    expect(Number((packed >> 41n) & 0x7n) + 1).toBe(2);
    expect(Number((packed >> 36n) & 0x1fn) + 1).toBe(16);
    expect(Number(packed & 0xfffffffffn)).toBe(32);
    expect(hex(streamInfoMd5(bytes))).toBe(expectedPcmMd5([left, right], 16));

    const firstFrame = 42;
    expect(bytes[firstFrame]).toBe(0xff);
    expect(bytes[firstFrame + 1] & 0xfe).toBe(0xf8);
    expect(bytes[firstFrame + 2] >> 4).toBe(7);
    expect(bytes.length - firstFrame).toBeGreaterThanOrEqual(minFrameSize * 2);
  });

  it('adds a seek table and Vorbis comments for delivery metadata', () => {
    const bytes = encodeFlac([new Float32Array(32)], 48_000, {
      bitDepth: 16,
      blockSize: 16,
      metadata: {
        title: 'Mix',
        originator: 'Sonare Studio',
        originationDate: '2026-08-05',
        originationTime: '12:34:56',
      },
    });
    const blocks = metadataBlocks(bytes);
    expect(blocks.map((block) => block.type)).toEqual([0, 3, 4]);
    expect(blocks.map((block) => block.last)).toEqual([false, false, true]);
    expect(blocks[1].size).toBe(36); // two 18-byte seek points
    const seek = new DataView(bytes.buffer, bytes.byteOffset + blocks[1].offset, blocks[1].size);
    expect(seek.getBigUint64(0, false)).toBe(0n);
    expect(seek.getBigUint64(8, false)).toBe(0n);
    const comment = new TextDecoder().decode(
      bytes.slice(blocks[2].offset, blocks[2].offset + blocks[2].size),
    );
    expect(comment).toContain('Sonare Studio');
    expect(comment).toContain('TITLE=Mix');
  });

  it('uses fixed-predictor Rice subframes when they are smaller than verbatim PCM', () => {
    const ramp = Float32Array.from({ length: 64 }, (_, index) => index / 0x7fff);
    const bytes = encodeFlac([ramp], 48000, { bitDepth: 16, blockSize: 64 });

    const firstFrame = 42;
    const frameHeaderSize = 8;
    const subframeHeader = bytes[firstFrame + frameHeaderSize];
    const subframeType = (subframeHeader >> 1) & 0x3f;
    expect(subframeType).toBe(0b001010);

    const verbatimFrameSize = frameHeaderSize + 1 + ramp.length * 2 + 2;
    expect(u24(bytes, 12)).toBeLessThan(verbatimFrameSize);
    expect(bytes.length).toBeLessThan(42 + verbatimFrameSize);
  });

  it('uses constant subframes for repeated samples', () => {
    const dc = Float32Array.from({ length: 64 }, () => -0.125);
    const bytes = encodeFlac([dc], 48000, { bitDepth: 16, blockSize: 64 });

    const firstFrame = 42;
    const frameHeaderSize = 8;
    const subframeHeader = bytes[firstFrame + frameHeaderSize];
    const subframeType = (subframeHeader >> 1) & 0x3f;
    expect(subframeType).toBe(0);

    const constantFrameSize = frameHeaderSize + 1 + 2 + 2;
    const verbatimFrameSize = frameHeaderSize + 1 + dc.length * 2 + 2;
    expect(u24(bytes, 12)).toBe(constantFrameSize);
    expect(bytes.length).toBe(42 + constantFrameSize);
    expect(bytes.length).toBeLessThan(42 + verbatimFrameSize);
  });

  it('uses partitioned Rice coding when residual scale changes across a frame', () => {
    const chirp = Float32Array.from(
      { length: 128 },
      (_, index) => Math.sin(index * index * 0.006) * 0.4,
    );
    const bytes = encodeFlac([chirp], 48000, { bitDepth: 16, blockSize: 128 });

    const firstFrame = 42;
    const frameHeaderSize = 8;
    const subframeHeader = bytes[firstFrame + frameHeaderSize];
    const subframeType = (subframeHeader >> 1) & 0x3f;
    expect(subframeType).toBe(0b001100);

    const fixedOrder = subframeType - 0b001000;
    const residualHeader = bytes[firstFrame + frameHeaderSize + 1 + fixedOrder * 2];
    expect(residualHeader >> 6).toBe(0);
    expect((residualHeader >> 2) & 0x0f).toBeGreaterThan(0);

    const verbatimFrameSize = frameHeaderSize + 1 + chirp.length * 2 + 2;
    expect(u24(bytes, 12)).toBeLessThan(verbatimFrameSize);
    expect(bytes.length).toBeLessThan(42 + verbatimFrameSize);
  });

  it('uses LPC subframes when general linear prediction beats fixed predictors', () => {
    const ar = arSignal(1, 128);
    const bytes = encodeFlac([ar], 48000, { bitDepth: 16, blockSize: 128 });

    const firstFrame = 42;
    const frameHeaderSize = 8;
    const subframeHeader = bytes[firstFrame + frameHeaderSize];
    const subframeType = (subframeHeader >> 1) & 0x3f;
    expect(subframeType).toBe(0b100000);

    const verbatimFrameSize = frameHeaderSize + 1 + ar.length * 2 + 2;
    expect(u24(bytes, 12)).toBeLessThan(verbatimFrameSize);
    expect(bytes.length).toBeLessThan(42 + verbatimFrameSize);
  });

  it('considers LPC orders above two when they produce smaller frames', () => {
    const ar = highOrderArSignal(1794, 256, 4);
    const bytes = encodeFlac([ar], 48000, { bitDepth: 16, blockSize: 256 });

    const firstFrame = 42;
    const frameHeaderSize = 8;
    const subframeHeader = bytes[firstFrame + frameHeaderSize];
    const subframeType = (subframeHeader >> 1) & 0x3f;
    expect(subframeType).toBe(0b100010);

    const lpcOrder = (subframeType & 0x1f) + 1;
    expect(lpcOrder).toBeGreaterThan(2);
    const verbatimFrameSize = frameHeaderSize + 1 + ar.length * 2 + 2;
    expect(u24(bytes, 12)).toBeLessThan(verbatimFrameSize);
    expect(bytes.length).toBeLessThan(42 + verbatimFrameSize);
  });

  it('defaults to 24-bit output and rejects bad inputs', () => {
    const bytes = encodeFlac([new Float32Array(16)], 44100);
    const packed = streamInfoPacked(bytes);
    expect(Number((packed >> 36n) & 0x1fn) + 1).toBe(24);

    expect(() => encodeFlac([], 44100)).toThrow(RangeError);
    expect(() => encodeFlac([new Float32Array(16), new Float32Array(15)], 44100)).toThrow(
      RangeError,
    );
    expect(() => encodeFlac([new Float32Array(16)], 0)).toThrow(RangeError);
    expect(() => encodeFlac([new Float32Array(16)], 44100, { bitDepth: 32 as 24 })).toThrow(
      RangeError,
    );
  });

  it('encodes short streams and short final frames', () => {
    const oneFrame = encodeFlac([new Float32Array(17)], 44100, { blockSize: 4096 });
    expect(u16(oneFrame, 8)).toBe(17);
    expect(u16(oneFrame, 10)).toBe(17);

    const adjusted = encodeFlac([new Float32Array(4097)], 44100, { blockSize: 4096 });
    expect(u16(adjusted, 8)).toBe(16);
    expect(u16(adjusted, 10)).toBe(4096);

    for (let frames = 1; frames < 16; frames += 1) {
      const short = encodeFlac([new Float32Array(frames)], 44100);
      expect(u16(short, 8)).toBe(16);
      expect(u16(short, 10)).toBe(16);
      expect(Number(streamInfoPacked(short) & 0xfffffffffn)).toBe(frames);
      // The STREAMINFO contract uses the legal minimum, while the frame
      // header still declares the actual number of samples in the final frame.
      expect(u16(short, 42 + 5) + 1).toBe(frames);
    }
  });

  it('is byte-deterministic for identical PCM and options', () => {
    const channels = [
      Float32Array.from({ length: 64 }, (_, index) => Math.sin(index / 8) * 0.5),
      Float32Array.from({ length: 64 }, (_, index) => Math.cos(index / 8) * 0.5),
    ];
    const first = encodeFlac(channels, 48000, { bitDepth: 24, blockSize: 32 });
    const second = encodeFlac(channels, 48000, { bitDepth: 24, blockSize: 32 });

    expect(second).toEqual(first);
  });

  it('applies reproducible TPDF dither only to 16-bit output', () => {
    const silence = [new Float32Array(64)];
    const plain = encodeFlac(silence, 48000, { bitDepth: 16, blockSize: 64 });
    const dithered = encodeFlac(silence, 48000, { bitDepth: 16, dither: true, blockSize: 64 });

    expect(dithered).not.toEqual(plain);
    expect(encodeFlac(silence, 48000, { bitDepth: 16, dither: true, blockSize: 64 })).toEqual(
      dithered,
    );
    expect(encodeFlac(silence, 48000, { bitDepth: 24, dither: true, blockSize: 64 })).toEqual(
      encodeFlac(silence, 48000, { bitDepth: 24, blockSize: 64 }),
    );
  });

  it('reports monotonic frame progress that ends at a full bar', () => {
    // Five blocks worth of audio drives several ticks before completion.
    const channels = [Float32Array.from({ length: 160 }, (_, index) => Math.sin(index / 4) * 0.5)];
    const fractions: number[] = [];
    encodeFlac(channels, 48000, { bitDepth: 16, blockSize: 32 }, (fraction) => {
      fractions.push(fraction);
    });

    expect(fractions.length).toBeGreaterThan(1);
    for (const fraction of fractions) {
      expect(fraction).toBeGreaterThan(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < fractions.length; i += 1) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    }
    expect(fractions.at(-1)).toBe(1);
  });

  it('resolves progress to a full bar even for an empty stream', () => {
    const fractions: number[] = [];
    encodeFlac([new Float32Array(0)], 44100, { blockSize: 16 }, (fraction) => {
      fractions.push(fraction);
    });
    expect(fractions).toEqual([1]);
  });

  it('allows an empty stream with STREAMINFO total samples set to zero', () => {
    const bytes = encodeFlac([new Float32Array(0)], 44100, { blockSize: 16 });
    const packed = streamInfoPacked(bytes);

    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('fLaC');
    expect(Number((packed >> 44n) & 0xfffffn)).toBe(44100);
    expect(Number(packed & 0xfffffffffn)).toBe(0);
    expect(u24(bytes, 12)).toBe(0);
    expect(u24(bytes, 15)).toBe(0);
    expect(hex(streamInfoMd5(bytes))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(bytes.length).toBe(42);
  });
});

describe('flac encoder registration', () => {
  it('registers once and exposes registry metadata', () => {
    const hadFlac = listEncoders().some((encoder) => encoder.id === FLAC_ENCODER_ID);
    expect(registerFlacEncoder()).toBe(!hadFlac);
    expect(registerFlacEncoder()).toBe(false);
    const encoder = getEncoder(FLAC_ENCODER_ID);
    expect(encoder.id).toBe('flac');
    expect(encoder.extension).toBe('.flac');
    expect(encoder.mime).toBe('audio/flac');
    expect(encoder.deterministic).toBe(true);
  });

  it('maps the open option bag into encodeFlac', async () => {
    const encoder = createFlacEncoder();
    const channels = [new Float32Array(16)];
    const viaBag = await encoder.encode(channels, 44100, { bitDepth: 16, blockSize: 16 });
    expect(viaBag).toEqual(encodeFlac(channels, 44100, { bitDepth: 16, blockSize: 16 }));
  });
});
