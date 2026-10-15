import { describe, expect, it } from 'vitest';
import { downmixToMono } from '@/lib/audio-channels';

describe('downmixToMono', () => {
  it('averages channels frame by frame', () => {
    const mono = downmixToMono([
      new Float32Array([1, 0, -1, 0.5]),
      new Float32Array([0, 1, 1, 0.5]),
    ]);
    expect([...mono]).toEqual([0.5, 0.5, 0, 0.5]);
  });

  it('returns an empty buffer for no channels', () => {
    expect(downmixToMono([])).toEqual(new Float32Array(0));
  });

  it('returns mono input as-is unless a copy is requested', () => {
    const single = new Float32Array([1, 2]);
    expect(downmixToMono([single])).toBe(single);
    const copy = downmixToMono([single], { copy: true });
    expect(copy).toEqual(single);
    expect(copy).not.toBe(single);
  });

  it('never yields NaN when a later channel is shorter than the first', () => {
    const mono = downmixToMono([new Float32Array([1, 1, 1, 1]), new Float32Array([1, 1])]);
    expect(mono.length).toBe(4);
    expect(mono.every((value) => Number.isFinite(value))).toBe(true);
  });
});
