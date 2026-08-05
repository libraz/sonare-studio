import { describe, expect, it, vi } from 'vitest';
import { encodeWav, wavFileSize, wavLayout } from '@/export/wav';

/** Reads an ASCII four-character tag at an offset. */
function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + 4));
}

/** DataView over the full byte array. */
function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Reads one signed little-endian 24-bit sample. */
function readInt24(bytes: Uint8Array, offset: number): number {
  const raw = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  return raw >= 0x800000 ? raw - 0x1000000 : raw;
}

function riffChunks(bytes: Uint8Array): Array<{ tag: string; offset: number; size: number }> {
  const chunks: Array<{ tag: string; offset: number; size: number }> = [];
  const output = view(bytes);
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const size = output.getUint32(offset + 4, true);
    chunks.push({ tag: tag(bytes, offset), offset, size });
    offset += 8 + size + (size & 1);
  }
  return chunks;
}

describe('encodeWav', () => {
  it('uses one resolved layout for header fields and allocation', () => {
    expect(wavLayout(1, 1, 24)).toMatchObject({
      sampleBytes: 3,
      blockAlign: 3,
      dataSize: 3,
      dataPad: 1,
      fmtSize: 16,
      riffSize: 40,
      fileSize: 48,
    });
  });

  describe('16-bit PCM (default)', () => {
    const left = new Float32Array([0, 0.5, 1, -1]);
    const right = new Float32Array([0.25, -0.5, 0.75, 0]);

    it('writes a correct RIFF/fmt/data header', () => {
      const bytes = encodeWav([left, right], 48000);
      const v = view(bytes);
      const dataSize = 4 * 2 * 2; // frames * channels * bytes
      expect(tag(bytes, 0)).toBe('RIFF');
      expect(v.getUint32(4, true)).toBe(36 + dataSize);
      expect(tag(bytes, 8)).toBe('WAVE');
      expect(tag(bytes, 12)).toBe('fmt ');
      expect(v.getUint32(16, true)).toBe(16); // fmt chunk size
      expect(v.getUint16(20, true)).toBe(1); // PCM format tag
      expect(v.getUint16(22, true)).toBe(2); // channels
      expect(v.getUint32(24, true)).toBe(48000); // sample rate
      expect(v.getUint32(28, true)).toBe(48000 * 4); // byte rate
      expect(v.getUint16(32, true)).toBe(4); // block align
      expect(v.getUint16(34, true)).toBe(16); // bits per sample
      expect(tag(bytes, 36)).toBe('data');
      expect(v.getUint32(40, true)).toBe(dataSize);
      expect(bytes.length).toBe(44 + dataSize);
    });

    it('quantizes with the asymmetric signed-PCM full scale', () => {
      const bytes = encodeWav([left, right], 48000);
      const v = view(bytes);
      // Frame-major interleaving: L0 R0 L1 R1 ...
      expect(v.getInt16(44, true)).toBe(0);
      // Positive samples scale by 0x7fff, negatives by 0x8000 to reach the full
      // signed-PCM range, matching the FLAC and MP3 encoders.
      expect(v.getInt16(46, true)).toBe(Math.round(0.25 * 0x7fff));
      expect(v.getInt16(48, true)).toBe(Math.round(0.5 * 0x7fff));
      expect(v.getInt16(50, true)).toBe(Math.round(-0.5 * 0x8000));
      expect(v.getInt16(52, true)).toBe(0x7fff);
      expect(v.getInt16(56, true)).toBe(-0x8000);
    });

    it('hard-clips over-range input to full scale', () => {
      const bytes = encodeWav([new Float32Array([2.5, -3])], 44100);
      const v = view(bytes);
      expect(v.getInt16(44, true)).toBe(0x7fff);
      expect(v.getInt16(46, true)).toBe(-0x8000);
    });

    it('encodes non-finite samples as silence in every WAV format', () => {
      const signal = [new Float32Array([Number.NaN, Number.POSITIVE_INFINITY])];
      for (const bitDepth of [16, 24, '32f'] as const) {
        const bytes = encodeWav(signal, 44100, { bitDepth });
        const output = view(bytes);
        if (bitDepth === 16) {
          expect(output.getInt16(44, true)).toBe(0);
          expect(output.getInt16(46, true)).toBe(0);
        } else if (bitDepth === 24) {
          expect(readInt24(bytes, 44)).toBe(0);
          expect(readInt24(bytes, 47)).toBe(0);
        } else {
          expect(output.getFloat32(58, true)).toBe(0);
          expect(output.getFloat32(62, true)).toBe(0);
        }
      }
    });

    it('supports mono', () => {
      const bytes = encodeWav([new Float32Array([1])], 22050);
      const v = view(bytes);
      expect(v.getUint16(22, true)).toBe(1);
      expect(v.getUint16(32, true)).toBe(2); // block align
      expect(v.getUint32(40, true)).toBe(2);
      expect(bytes.length).toBe(46);
    });
  });

  it('writes BWF origin data and named cue labels when delivery metadata is supplied', () => {
    const bytes = encodeWav([new Float32Array([0, 0])], 48_000, {
      metadata: {
        title: 'Mix',
        originator: 'Sonare Studio',
        originatorReference: 'session-7',
        originationDate: '2026-08-05',
        originationTime: '12:34:56',
        timeReference: 0,
        markers: [{ sampleOffset: 1, name: 'Drop' }],
      },
    });
    const chunks = riffChunks(bytes);
    expect(chunks.map((chunk) => chunk.tag)).toEqual(['fmt ', 'bext', 'data', 'cue ', 'LIST']);
    const bext = chunks[1];
    expect(bext.size).toBe(602);
    expect(String.fromCharCode(...bytes.slice(bext.offset + 8, bext.offset + 11))).toBe('Mix');
    expect(String.fromCharCode(...bytes.slice(bext.offset + 8 + 256, bext.offset + 8 + 269))).toBe(
      'Sonare Studio',
    );
    const cue = chunks[3];
    const output = view(bytes);
    expect(output.getUint32(cue.offset + 8, true)).toBe(1);
    expect(output.getUint32(cue.offset + 8 + 4 + 20, true)).toBe(1);
    const labels = new TextDecoder().decode(bytes.slice(chunks[4].offset + 12));
    expect(labels).toContain('Drop');
    expect(output.getUint32(4, true) + 8).toBe(bytes.length);
  });

  describe('TPDF dither', () => {
    it('keeps dithered 16-bit samples within one LSB of the undithered value', () => {
      const signal = new Float32Array(512);
      for (let i = 0; i < signal.length; i++) signal[i] = 0.4 * Math.sin(i / 7);
      const plain = encodeWav([signal], 48000);
      const dithered = encodeWav([signal], 48000, { dither: true });
      const vp = view(plain);
      const vd = view(dithered);
      let changed = 0;
      for (let i = 0; i < signal.length; i++) {
        const a = vp.getInt16(44 + i * 2, true);
        const b = vd.getInt16(44 + i * 2, true);
        expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
        if (a !== b) changed += 1;
      }
      // The triangular noise must actually move some samples.
      expect(changed).toBeGreaterThan(0);
    });

    it('never exceeds the int16 range at full scale', () => {
      const signal = new Float32Array(64).fill(1);
      const bytes = encodeWav([signal], 48000, { dither: true, random: () => 0.999 });
      const v = view(bytes);
      for (let i = 0; i < signal.length; i++) {
        expect(v.getInt16(44 + i * 2, true)).toBe(32767);
      }
    });

    it('is deterministic with an injected noise source', () => {
      const signal = new Float32Array([0.123, -0.456, 0.789]);
      const random = () => 0.75;
      const a = encodeWav([signal], 48000, { dither: true, random });
      const b = encodeWav([signal], 48000, { dither: true, random });
      expect(a).toEqual(b);
    });

    it('is ignored for 24-bit and float output', () => {
      const random = vi.fn(() => 0.9);
      const signal = [new Float32Array([0.5])];
      encodeWav(signal, 48000, { bitDepth: 24, dither: true, random });
      encodeWav(signal, 48000, { bitDepth: '32f', dither: true, random });
      expect(random).not.toHaveBeenCalled();
    });
  });

  describe('24-bit PCM', () => {
    it('packs signed little-endian 3-byte samples', () => {
      const bytes = encodeWav([new Float32Array([1, -1, 0.5, 0])], 48000, { bitDepth: 24 });
      const v = view(bytes);
      expect(v.getUint16(34, true)).toBe(24);
      expect(v.getUint16(32, true)).toBe(3); // block align (mono)
      expect(readInt24(bytes, 44)).toBe(0x7fffff);
      expect(readInt24(bytes, 47)).toBe(-0x800000);
      expect(readInt24(bytes, 50)).toBe(Math.round(0.5 * 0x7fffff));
      expect(readInt24(bytes, 53)).toBe(0);
    });

    it('pads an odd-sized data chunk to word alignment', () => {
      const bytes = encodeWav([new Float32Array([0.1])], 48000, { bitDepth: 24 });
      const v = view(bytes);
      expect(v.getUint32(40, true)).toBe(3); // data size excludes the pad
      expect(v.getUint32(4, true)).toBe(36 + 3 + 1); // RIFF size includes it
      expect(bytes.length).toBe(44 + 3 + 1);
      expect(bytes[bytes.length - 1]).toBe(0);
    });

    it('clips over-range input', () => {
      const bytes = encodeWav([new Float32Array([5, -5])], 48000, { bitDepth: 24 });
      expect(readInt24(bytes, 44)).toBe(0x7fffff);
      expect(readInt24(bytes, 47)).toBe(-0x800000);
    });
  });

  describe('32-bit float', () => {
    it('writes format tag 3 with a fact chunk', () => {
      const bytes = encodeWav([new Float32Array([0.5]), new Float32Array([-0.5])], 96000, {
        bitDepth: '32f',
      });
      const v = view(bytes);
      expect(v.getUint32(16, true)).toBe(18); // fmt size with cbSize field
      expect(v.getUint16(20, true)).toBe(3); // IEEE float format tag
      expect(v.getUint16(34, true)).toBe(32);
      expect(v.getUint16(36, true)).toBe(0); // cbSize
      expect(tag(bytes, 38)).toBe('fact');
      expect(v.getUint32(42, true)).toBe(4);
      expect(v.getUint32(46, true)).toBe(1); // frames per channel
      expect(tag(bytes, 50)).toBe('data');
      expect(v.getUint32(54, true)).toBe(8);
      expect(v.getUint32(4, true)).toBe(4 + 26 + 12 + 16);
      expect(bytes.length).toBe(58 + 8);
    });

    it('passes samples through bit-exactly, preserving over-range values', () => {
      const input = new Float32Array([0.123, -0.987, 1.5, -2.25]);
      const bytes = encodeWav([input], 48000, { bitDepth: '32f' });
      const v = view(bytes);
      for (let i = 0; i < input.length; i++) {
        expect(v.getFloat32(58 + i * 4, true)).toBe(input[i]);
      }
    });
  });

  describe('validation', () => {
    it('accepts the largest stereo 16-bit layout that fits RIFF and rejects the next frame', () => {
      const maxFrames = 1_073_741_814;
      expect(wavFileSize(maxFrames, 2, 16)).toBe(4_294_967_300);
      expect(() => wavFileSize(maxFrames + 1, 2, 16)).toThrow(/RIFF 4 GiB limit/);
    });

    it('rejects empty channel lists', () => {
      expect(() => encodeWav([], 48000)).toThrow(RangeError);
    });

    it('rejects mismatched channel lengths', () => {
      expect(() => encodeWav([new Float32Array(2), new Float32Array(3)], 48000)).toThrow(
        RangeError,
      );
    });

    it('rejects bad sample rates', () => {
      expect(() => encodeWav([new Float32Array(1)], 0)).toThrow(RangeError);
      expect(() => encodeWav([new Float32Array(1)], -1)).toThrow(RangeError);
      expect(() => encodeWav([new Float32Array(1)], 44100.5)).toThrow(RangeError);
    });

    it('rejects unsupported bit depths', () => {
      expect(() =>
        encodeWav([new Float32Array(1)], 48000, { bitDepth: 8 as unknown as 16 }),
      ).toThrow(RangeError);
    });

    it('encodes zero frames into a header-only file', () => {
      const bytes = encodeWav([new Float32Array(0)], 48000);
      const v = view(bytes);
      expect(v.getUint32(40, true)).toBe(0);
      expect(bytes.length).toBe(44);
    });
  });
});
