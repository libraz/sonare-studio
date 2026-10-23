import { describe, expect, it } from 'vitest';
import { encodeWav, encodeWavChunk } from '@/export/wav';

function signal(frames: number): Float32Array {
  return Float32Array.from({ length: frames }, (_, i) => Math.sin(i * 0.01) * 0.3 + 1e-5 * i);
}

describe('WAV dither', () => {
  it('is byte-identical across repeated encodes', () => {
    const channels = [signal(512), signal(512)];
    const a = encodeWav(channels, 48000, { dither: true });
    const b = encodeWav(channels, 48000, { dither: true });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('streams chunks to the same bytes as the whole-buffer encode', () => {
    const channels = [signal(300), signal(300).map((v) => -v)];
    const whole = encodeWavChunk(channels, 16, { dither: true });
    const split = 128;
    const first = encodeWavChunk(
      channels.map((c) => c.subarray(0, split)),
      16,
      { dither: true },
      0,
    );
    const second = encodeWavChunk(
      channels.map((c) => c.subarray(split)),
      16,
      { dither: true },
      split,
    );
    expect(Array.from([...first, ...second])).toEqual(Array.from(whole));
  });
});
