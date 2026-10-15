import { describe, expect, it } from 'vitest';
import { hasStructurallyCompleteMedia } from '@/export/media-container-validation';

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];
}

function crc(bytes: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = i >= 22 && i < 26 ? 0 : bytes[i]!;
    c ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  }
  return c >>> 0;
}

function page(packet: number[], sequence: number, headerType: number, granule = 0): number[] {
  const segments: number[] = [];
  let left = packet.length;
  while (left >= 255) {
    segments.push(255);
    left -= 255;
  }
  segments.push(left);
  const bytes = Uint8Array.from([
    0x4f,
    0x67,
    0x67,
    0x53,
    0,
    headerType,
    ...u32(granule),
    0,
    0,
    0,
    0,
    ...u32(0x12345678),
    ...u32(sequence),
    0,
    0,
    0,
    0,
    segments.length,
    ...segments,
    ...packet,
  ]);
  bytes.set(u32(crc(bytes)), 22);
  return Array.from(bytes);
}

const ascii = (text: string) => Array.from(new TextEncoder().encode(text));

function fixture(audioLength: number): Uint8Array {
  const head = [...ascii('OpusHead'), 1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0];
  const tags = [...ascii('OpusTags'), 0, 0, 0, 0, 0, 0, 0, 0];
  const audio = Array.from({ length: audioLength }, (_, i) => (i % 250) + 1);
  return Uint8Array.from([
    ...page(head, 0, 0x02),
    ...page(tags, 1, 0),
    ...page(audio, 2, 0x04, 960),
  ]);
}

describe('ogg validation', () => {
  it('accepts a stream with a multi-segment audio packet and rejects a corrupt CRC', () => {
    const bytes = fixture(3000);
    expect(hasStructurallyCompleteMedia(bytes, 'audio/ogg;codecs=opus')).toBe(true);
    const bad = bytes.slice();
    bad[bad.length - 1] ^= 0xff;
    expect(hasStructurallyCompleteMedia(bad, 'audio/ogg;codecs=opus')).toBe(false);
  });

  it('does not copy the payload byte by byte', () => {
    const bytes = fixture(3000);
    const original = Array.prototype.push;
    let pushes = 0;
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      pushes += 1;
      return original.apply(this, items);
    };
    try {
      expect(hasStructurallyCompleteMedia(bytes, 'audio/ogg;codecs=opus')).toBe(true);
    } finally {
      Array.prototype.push = original;
    }
    expect(pushes).toBeLessThan(50);
  });
});
