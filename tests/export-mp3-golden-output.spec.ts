import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeMp3 } from '@/export/mp3';

function tone(frames: number, hz: number): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) out[i] = 0.5 * Math.sin((i * hz * 2 * Math.PI) / 44100);
  return out;
}

const cases: Array<[string, number, number, Parameters<typeof encodeMp3>[2]]> = [
  ['stereo', 20000, 2, { bitrate: 192 }],
  ['mono-meta', 5000, 1, { bitrate: 128, metadata: { title: 'T', originator: 'O' } }],
  ['empty', 0, 1, {}],
  ['short', 300, 2, { bitrate: 320 }],
];

const GOLDEN: Record<string, string> = {
  stereo: 'b54e50a074a467ff7611413188b367099d3ece55f3f6844682223acb446ba132',
  'mono-meta': 'b6186e390a42ad8f3ec86a587d3bd733e8072e54cadf97e4e6bdbd5635b62bbf',
  empty: '111c8b750cd0d18d2cfa34151bdfb7999db3075538de13c13062cb601c4fc2fa',
  short: 'ec3d37d75dc2144c3129c37a43925653d421a4ae8de253d73067d349795ec5d4',
};

describe('mp3 golden output', () => {
  for (const [name, frames, channelCount, options] of cases) {
    it(name, async () => {
      const channels = Array.from({ length: channelCount }, (_, c) => tone(frames, 440 + c * 70));
      const digest = createHash('sha256')
        .update(await encodeMp3(channels, 44100, options))
        .digest('hex');
      expect(digest).toBe(GOLDEN[name]);
    });
  }
});
