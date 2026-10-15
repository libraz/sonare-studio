import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeFlac } from '@/export/flac';

function signal(kind: string, frames: number, channel: number): Float32Array {
  const out = new Float32Array(frames);
  let seed = 12345 + channel * 977;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000 - 0.5;
  };
  for (let i = 0; i < frames; i += 1) {
    switch (kind) {
      case 'sine':
        out[i] = 0.6 * Math.sin((i * (440 + channel * 90) * 2 * Math.PI) / 44100);
        break;
      case 'noise':
        out[i] = rand() * 1.9;
        break;
      case 'square':
        out[i] = Math.floor(i / 37) % 2 === 0 ? 1 : -1;
        break;
      case 'burst':
        out[i] = i % 3000 < 40 ? rand() * 2 : 0.001 * Math.sin(i / 9);
        break;
      case 'const':
        out[i] = 0.25;
        break;
      default:
        out[i] = 0;
    }
  }
  return out;
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const metadata = {
  title: 'Golden',
  originator: 'Sonare',
  originationDate: '2024-01-02',
  originationTime: '03:04:05',
};

const cases: Array<[string, string, number, number, Parameters<typeof encodeFlac>[2]]> = [
  ['sine24', 'sine', 20000, 2, { bitDepth: 24 }],
  ['sine16', 'sine', 10000, 1, { bitDepth: 16, blockSize: 1152 }],
  ['noise24', 'noise', 9000, 2, { bitDepth: 24, blockSize: 512 }],
  ['noise16dither', 'noise', 5000, 2, { bitDepth: 16, dither: true }],
  ['square16', 'square', 8000, 2, { bitDepth: 16 }],
  ['burst24meta', 'burst', 20000, 2, { bitDepth: 24, metadata }],
  ['const', 'const', 6000, 1, { bitDepth: 16, blockSize: 16 }],
  ['silence', 'zero', 5000, 2, {}],
  ['empty', 'zero', 0, 2, {}],
  ['tiny', 'sine', 7, 1, { bitDepth: 16 }],
];

const GOLDEN: Record<string, string> = {
  sine24: '60a4609c637d61a6f1f75ca073621c3d741b3bbd0dcd597e26eb4bda69b180d4',
  sine16: 'e917fea3ae36ad3fa60c9408e658bf22b5c02d90059d73a0fa99d8a723a9c6eb',
  noise24: '3db4983e92a53403c022d139325496da525bfe310b29b22a37848878d813917c',
  noise16dither: '996245859d6ee877befa7c565be69392682956c0957c1787833ebb499cf651e1',
  square16: '5b2751ada270f05524458b87bf379529bcd4ead36a879ea30b5771eab5e53089',
  burst24meta: '29f16c9220f123677fb5bf7207a258b33f7569bbfe9afdf7d0b2b149a1605b64',
  const: '048a0c56156e766457815cf38e341efe6fba24ed58bef4185357d240015411a2',
  silence: '3f7287a48f7202f57bb12aef873a55cd7a9b0e7167f389db3e26322e42fff983',
  empty: 'fcc9fb1630cf2efed57b08a6c06f4f4249ce80769cbc7e18e715896117345ec0',
  tiny: '1db9f0c2699fdfa7c8df933e2ae9642d6873190be287f64a91a0d42502978423',
};

describe('flac golden output', () => {
  for (const [name, kind, frames, channelCount, options] of cases) {
    it(name, () => {
      const channels = Array.from({ length: channelCount }, (_, c) => signal(kind, frames, c));
      const digest = hash(encodeFlac(channels, 44100, options));
      expect(digest).toBe(GOLDEN[name]);
    });
  }
});

describe('flac bit packing cost', () => {
  it('does not allocate a BigInt per written bit', () => {
    const original = globalThis.BigInt;
    let calls = 0;
    globalThis.BigInt = new Proxy(original, {
      apply(target, thisArg, args) {
        calls += 1;
        return Reflect.apply(target, thisArg, args);
      },
    });
    try {
      encodeFlac([signal('noise', 4000, 0)], 44100, { bitDepth: 16 });
    } finally {
      globalThis.BigInt = original;
    }
    expect(calls).toBeLessThan(100);
  });
});
