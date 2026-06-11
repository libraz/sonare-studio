import { describe, expect, it } from 'vitest';
import { eqBandResponseDb, eqCurve, eqCurvePath } from '@/ui/mixer/eq-curve';
import type { EqBand } from '@/wasm/index.js';

describe('eqBandResponseDb', () => {
  it('a peak band boosts by its gain at the center frequency', () => {
    const band: EqBand = { type: 'Peak', frequencyHz: 1000, gainDb: 6, q: 1 };
    expect(eqBandResponseDb(band, 1000)).toBeCloseTo(6, 1);
  });

  it('a peak band is near flat far from the center', () => {
    const band: EqBand = { type: 'Peak', frequencyHz: 1000, gainDb: 6, q: 1 };
    expect(Math.abs(eqBandResponseDb(band, 30))).toBeLessThan(0.5);
    expect(Math.abs(eqBandResponseDb(band, 18000))).toBeLessThan(0.5);
  });

  it('a cut peak attenuates at the center frequency', () => {
    const band: EqBand = { type: 'Peak', frequencyHz: 500, gainDb: -9, q: 2 };
    expect(eqBandResponseDb(band, 500)).toBeCloseTo(-9, 1);
  });

  it('a low shelf boosts the lows and leaves the highs flat', () => {
    const band: EqBand = { type: 'LowShelf', frequencyHz: 200, gainDb: 6 };
    expect(eqBandResponseDb(band, 20)).toBeCloseTo(6, 0);
    expect(Math.abs(eqBandResponseDb(band, 10000))).toBeLessThan(0.5);
  });

  it('a high shelf boosts the highs and leaves the lows flat', () => {
    const band: EqBand = { type: 'HighShelf', frequencyHz: 5000, gainDb: 6 };
    expect(eqBandResponseDb(band, 18000)).toBeCloseTo(6, 0);
    expect(Math.abs(eqBandResponseDb(band, 100))).toBeLessThan(0.5);
  });

  it('a high pass attenuates below its corner', () => {
    const band: EqBand = { type: 'HighPass', frequencyHz: 1000 };
    expect(eqBandResponseDb(band, 100)).toBeLessThan(-20);
    expect(Math.abs(eqBandResponseDb(band, 10000))).toBeLessThan(1);
  });

  it('a low pass attenuates above its corner', () => {
    const band: EqBand = { type: 'LowPass', frequencyHz: 1000 };
    expect(eqBandResponseDb(band, 10000)).toBeLessThan(-20);
    expect(Math.abs(eqBandResponseDb(band, 100))).toBeLessThan(1);
  });

  it('a notch cuts hard at its center', () => {
    const band: EqBand = { type: 'Notch', frequencyHz: 1000, q: 4 };
    expect(eqBandResponseDb(band, 1000)).toBeLessThan(-30);
    expect(Math.abs(eqBandResponseDb(band, 100))).toBeLessThan(1);
  });

  it('disabled or bypassed bands are flat', () => {
    expect(
      eqBandResponseDb({ type: 'Peak', frequencyHz: 1000, gainDb: 12, enabled: false }, 1000),
    ).toBe(0);
    expect(
      eqBandResponseDb({ type: 'Peak', frequencyHz: 1000, gainDb: 12, bypassed: true }, 1000),
    ).toBe(0);
  });

  it('band types without a biquad equivalent render flat', () => {
    expect(eqBandResponseDb({ type: 'TiltShelf', frequencyHz: 700, gainDb: 6 }, 700)).toBe(0);
  });

  it('defaults to a peak at 1 kHz', () => {
    expect(eqBandResponseDb({ gainDb: 6 }, 1000)).toBeCloseTo(6, 1);
  });
});

describe('eqCurve', () => {
  it('samples the requested number of points on an ascending log axis', () => {
    const curve = eqCurve([{ type: 'Peak', frequencyHz: 1000, gainDb: 3 }], 32);
    expect(curve).toHaveLength(32);
    expect(curve[0].hz).toBeCloseTo(20, 6);
    expect(curve[curve.length - 1].hz).toBeCloseTo(20000, 3);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i].hz).toBeGreaterThan(curve[i - 1].hz);
    }
  });

  it('sums the responses of multiple bands', () => {
    const bands: EqBand[] = [
      { type: 'Peak', frequencyHz: 1000, gainDb: 6, q: 1 },
      { type: 'Peak', frequencyHz: 1000, gainDb: -2, q: 1 },
    ];
    const single = eqBandResponseDb(bands[0], 1000) + eqBandResponseDb(bands[1], 1000);
    const curve = eqCurve(bands, 257, 999, 1001);
    const center = curve[Math.floor(curve.length / 2)];
    expect(center.db).toBeCloseTo(single, 1);
  });

  it('is flat for an empty or fully inactive band list', () => {
    for (const point of eqCurve([], 8)) expect(point.db).toBe(0);
    const inactive = eqCurve([{ type: 'Peak', gainDb: 12, enabled: false }], 8);
    for (const point of inactive) expect(point.db).toBe(0);
  });
});

describe('eqCurvePath', () => {
  it('renders a flat curve as a horizontal centerline', () => {
    const path = eqCurvePath(
      [
        { hz: 20, db: 0 },
        { hz: 20000, db: 0 },
      ],
      80,
      30,
    );
    expect(path).toBe('M0.0 15.0 L80.0 15.0');
  });

  it('maps boosts above and cuts below the centerline, clamped to the edges', () => {
    const path = eqCurvePath(
      [
        { hz: 20, db: 9 },
        { hz: 200, db: -9 },
        { hz: 20000, db: 100 },
      ],
      80,
      30,
      18,
    );
    const ys = [...path.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => Number(m[2]));
    expect(ys[0]).toBeCloseTo(7.5, 5); // +9 dB of 18 -> quarter from the top.
    expect(ys[1]).toBeCloseTo(22.5, 5);
    expect(ys[2]).toBe(0); // Clamped at the top edge.
  });

  it('returns an empty path for an empty curve', () => {
    expect(eqCurvePath([], 80, 30)).toBe('');
  });
});
