import { describe, expect, it } from 'vitest';
import { dbToLinear, linearToDb, peakDb, SILENCE_DB } from '@/lib/db';

describe('dbToLinear', () => {
  it('maps 0 dB to unity and is the inverse of decade steps', () => {
    expect(dbToLinear(0)).toBe(1);
    expect(dbToLinear(20)).toBeCloseTo(10, 10);
    expect(dbToLinear(-20)).toBeCloseTo(0.1, 10);
    expect(dbToLinear(-6)).toBeCloseTo(0.5012, 3);
  });

  it('maps negative infinity to silence', () => {
    expect(dbToLinear(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('linearToDb', () => {
  it('clamps zero and non-positive input to the silence floor', () => {
    expect(linearToDb(0)).toBe(SILENCE_DB);
    expect(linearToDb(-1)).toBe(SILENCE_DB);
    expect(linearToDb(Number.NaN)).toBe(SILENCE_DB);
  });

  it('round-trips with dbToLinear above the floor', () => {
    expect(linearToDb(1)).toBeCloseTo(0, 10);
    expect(linearToDb(dbToLinear(-6))).toBeCloseTo(-6, 10);
  });

  it('never drops below the silence floor', () => {
    expect(linearToDb(1e-12)).toBe(SILENCE_DB);
  });
});

describe('peakDb', () => {
  it('reports a true -infinity at digital silence (no floor clamp)', () => {
    expect(peakDb(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(peakDb(-1)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('measures levels above silence', () => {
    expect(peakDb(1)).toBeCloseTo(0, 10);
    expect(peakDb(0.5)).toBeCloseTo(-6.02, 2);
  });
});
