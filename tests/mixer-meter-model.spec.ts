import { describe, expect, it } from 'vitest';
import {
  advanceMeterChannel,
  CLIP_THRESHOLD_DB,
  createMeterChannel,
  isMeterAtFloor,
  METER_MIN_DB,
  meterFraction,
  PEAK_DECAY_DB_PER_S,
  PEAK_HOLD_DECAY_DB_PER_S,
  PEAK_HOLD_MS,
  RMS_DECAY_DB_PER_S,
  resetMeterClip,
} from '@/ui/mixer/meter-model';

const SILENT = { peakDb: METER_MIN_DB, rmsDb: METER_MIN_DB };

describe('createMeterChannel', () => {
  it('starts silent at the floor with no clip', () => {
    const model = createMeterChannel();
    expect(model.peakDb).toBe(METER_MIN_DB);
    expect(model.rmsDb).toBe(METER_MIN_DB);
    expect(model.holdDb).toBe(METER_MIN_DB);
    expect(model.clipped).toBe(false);
  });
});

describe('advanceMeterChannel', () => {
  it('rises instantly to louder targets', () => {
    const model = createMeterChannel();
    advanceMeterChannel(model, { peakDb: -6, rmsDb: -12 }, 0.016, 0);
    expect(model.peakDb).toBe(-6);
    expect(model.rmsDb).toBe(-12);
    expect(model.holdDb).toBe(-6);
  });

  it('decays peak and RMS at their ballistic rates', () => {
    const model = createMeterChannel();
    advanceMeterChannel(model, { peakDb: -6, rmsDb: -6 }, 0, 0);
    advanceMeterChannel(model, SILENT, 0.5, 500);
    expect(model.peakDb).toBeCloseTo(-6 - PEAK_DECAY_DB_PER_S * 0.5, 9);
    expect(model.rmsDb).toBeCloseTo(-6 - RMS_DECAY_DB_PER_S * 0.5, 9);
  });

  it('never decays below the floor', () => {
    const model = createMeterChannel();
    advanceMeterChannel(model, { peakDb: -50, rmsDb: -50 }, 0, 0);
    advanceMeterChannel(model, SILENT, 10, 10000);
    expect(model.peakDb).toBe(METER_MIN_DB);
    expect(model.rmsDb).toBe(METER_MIN_DB);
  });

  it('holds the peak marker for the hold time before falling', () => {
    const model = createMeterChannel();
    advanceMeterChannel(model, { peakDb: -6, rmsDb: -6 }, 0, 0);
    // Within the hold window the marker stays put.
    advanceMeterChannel(model, SILENT, 0.5, PEAK_HOLD_MS - 1);
    expect(model.holdDb).toBe(-6);
    // After the window it falls at the hold decay rate.
    advanceMeterChannel(model, SILENT, 0.25, PEAK_HOLD_MS + 100);
    expect(model.holdDb).toBeCloseTo(-6 - PEAK_HOLD_DECAY_DB_PER_S * 0.25, 9);
  });

  it('raises the hold marker again on a louder peak', () => {
    const model = createMeterChannel();
    advanceMeterChannel(model, { peakDb: -12, rmsDb: -12 }, 0, 0);
    advanceMeterChannel(model, { peakDb: -3, rmsDb: -3 }, 0.016, 16);
    expect(model.holdDb).toBe(-3);
    expect(model.holdAtMs).toBe(16);
  });

  it('latches the clip flag at the threshold and keeps it latched', () => {
    const model = createMeterChannel();
    advanceMeterChannel(model, { peakDb: CLIP_THRESHOLD_DB, rmsDb: -3 }, 0.016, 0);
    expect(model.clipped).toBe(true);
    advanceMeterChannel(model, SILENT, 5, 5000);
    expect(model.clipped).toBe(true);
  });

  it('does not clip below the threshold', () => {
    const model = createMeterChannel();
    advanceMeterChannel(model, { peakDb: -0.5, rmsDb: -3 }, 0.016, 0);
    expect(model.clipped).toBe(false);
  });

  it('respects a custom floor', () => {
    const model = createMeterChannel(-90);
    advanceMeterChannel(model, { peakDb: -120, rmsDb: -120 }, 1, 1000, -90);
    expect(model.peakDb).toBe(-90);
  });
});

describe('resetMeterClip', () => {
  it('clears a latched clip', () => {
    const model = createMeterChannel();
    advanceMeterChannel(model, { peakDb: 1, rmsDb: 0 }, 0.016, 0);
    expect(model.clipped).toBe(true);
    resetMeterClip(model);
    expect(model.clipped).toBe(false);
  });
});

describe('meterFraction', () => {
  it('maps the floor to 0 and 0 dBFS to 1', () => {
    expect(meterFraction(METER_MIN_DB)).toBe(0);
    expect(meterFraction(0)).toBe(1);
    expect(meterFraction(METER_MIN_DB / 2)).toBeCloseTo(0.5, 9);
  });

  it('clamps overs and non-finite values', () => {
    expect(meterFraction(6)).toBe(1);
    expect(meterFraction(-200)).toBe(0);
    expect(meterFraction(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(meterFraction(Number.NaN)).toBe(0);
  });
});

describe('isMeterAtFloor', () => {
  it('is true only when peak, RMS and hold all rest at the floor', () => {
    expect(isMeterAtFloor(METER_MIN_DB, METER_MIN_DB, METER_MIN_DB)).toBe(true);
    expect(isMeterAtFloor(-12, METER_MIN_DB, METER_MIN_DB)).toBe(false);
    expect(isMeterAtFloor(METER_MIN_DB, -12, METER_MIN_DB)).toBe(false);
    expect(isMeterAtFloor(METER_MIN_DB, METER_MIN_DB, -12)).toBe(false);
  });

  it('respects a custom floor', () => {
    expect(isMeterAtFloor(-90, -90, -90, -90)).toBe(true);
    expect(isMeterAtFloor(-89, -90, -90, -90)).toBe(false);
  });

  it('becomes true once a silent channel has fully decayed', () => {
    const model = createMeterChannel();
    advanceMeterChannel(model, { peakDb: -6, rmsDb: -12 }, 0.016, 0);
    expect(isMeterAtFloor(model.peakDb, model.rmsDb, model.holdDb)).toBe(false);
    // Decay well past the hold time with silent targets.
    advanceMeterChannel(model, SILENT, 10, PEAK_HOLD_MS + 10_000);
    advanceMeterChannel(model, SILENT, 10, PEAK_HOLD_MS + 20_000);
    expect(isMeterAtFloor(model.peakDb, model.rmsDb, model.holdDb)).toBe(true);
  });
});
