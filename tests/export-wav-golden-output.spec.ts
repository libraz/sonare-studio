import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeWav, encodeWavChunk, wavHeader } from '@/export/wav';

function tone(frames: number, hz: number): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) out[i] = 1.2 * Math.sin((i * hz * 2 * Math.PI) / 44100);
  if (frames > 3) out[3] = Number.NaN;
  return out;
}

function lcg(): () => number {
  let seed = 7;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

const metadata = {
  title: 'Golden',
  originator: 'Sonare',
  originationDate: '2024-01-02',
  originationTime: '03:04:05',
  timeReference: 12345,
  markers: [
    { sampleOffset: 10, name: 'A' },
    { sampleOffset: 99, name: 'Marker B' },
  ],
};

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const cases: Array<[string, number, number, Parameters<typeof encodeWav>[2]]> = [
  ['pcm16', 1001, 2, { bitDepth: 16 }],
  ['pcm16-dither', 1001, 2, { bitDepth: 16, dither: true }],
  ['pcm24', 777, 3, { bitDepth: 24 }],
  ['float-meta', 501, 1, { bitDepth: '32f', metadata }],
  ['pcm16-odd-meta', 501, 1, { bitDepth: 24, metadata }],
  ['empty', 0, 2, {}],
];

const GOLDEN: Record<string, string> = {
  pcm16: '85a6911e41416ff4090e75e49006cceebdbe8c37ae839e4c0e57a5adb6b27634',
  'pcm16-dither': '2d51e517a50ba86936aa34e80e5bb9447557cac75def81ec9e454206845e0ba8',
  pcm24: '189c4623d9eb25b96cf05f53dbaef9b6ee4b6db3075661ec5a4f84915433d674',
  'float-meta': '9a61bf862bdea63c5506993e7d06207d93e9bc6d6b81b5b27fa6be2925e1af02',
  'pcm16-odd-meta': 'fc452523426fb2b2eb56aaffc7cf055ace47fb7378623d7b72269a0c3b651eeb',
  empty: '991cd2a53281fab26a26b23f2b3d7a020e277b83978ea36796679e0952ae7575',
};

describe('wav golden output', () => {
  for (const [name, frames, channelCount, options] of cases) {
    it(name, () => {
      const channels = Array.from({ length: channelCount }, (_, c) => tone(frames, 300 + c * 50));
      const digest = hash(encodeWav(channels, 44100, { ...options, random: lcg() }));
      expect(digest).toBe(GOLDEN[name]);
    });
  }

  it('chunk matches the sample region of the full file', () => {
    const channels = [tone(333, 440), tone(333, 550)];
    const full = encodeWav(channels, 44100, { bitDepth: 24 });
    const chunk = encodeWavChunk(channels, 24);
    const header = wavHeader(333, 2, 44100, 24);
    expect(hash(full.subarray(header.length))).toBe(hash(chunk));
  });

  it('rejects a RIFF size that only overflows once metadata is added', () => {
    const frames = (0xffff_ffff - 37) / 2;
    expect(() => wavHeader(frames, 1, 44100, 16)).not.toThrow();
    expect(() => wavHeader(frames, 1, 44100, 16, { metadata: { title: 'x' } })).toThrow(RangeError);
  });
});
