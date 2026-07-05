import { describe, expect, it } from 'vitest';
import { matchFlatEqBands } from '@/ui/mixer/match-eq';

describe('matchFlatEqBands', () => {
  it('builds corrective peak bands from broad live-spectrum imbalances', () => {
    const spectrum = new Float32Array(64).fill(-48);
    // Low-mid buildup and high-frequency dullness.
    spectrum[1] = -30;
    spectrum[2] = -30;
    spectrum[3] = -31;
    for (let index = 20; index <= 42; index += 1) spectrum[index] = -72;

    const bands = matchFlatEqBands(spectrum, { sampleRate: 48000, maxBands: 4 });

    expect(bands.length).toBeGreaterThanOrEqual(2);
    expect(bands.every((band) => band.type === 'Peak' && band.enabled === true)).toBe(true);
    expect(bands.some((band) => (band.frequencyHz ?? 0) < 1000 && (band.gainDb ?? 0) < 0)).toBe(
      true,
    );
    expect(bands.some((band) => (band.frequencyHz ?? 0) > 2500 && (band.gainDb ?? 0) > 0)).toBe(
      true,
    );
    expect(bands.every((band) => Math.abs(band.gainDb ?? 0) <= 9)).toBe(true);
  });

  it('returns no bands for silence or invalid sample rates', () => {
    expect(matchFlatEqBands(new Float32Array(16).fill(-120), { sampleRate: 48000 })).toEqual([]);
    expect(matchFlatEqBands(new Float32Array(16).fill(-48), { sampleRate: 0 })).toEqual([]);
  });
});
