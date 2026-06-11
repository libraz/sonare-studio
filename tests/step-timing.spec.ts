import { describe, expect, it } from 'vitest';
import {
  isTripletResolution,
  nearestStepForPpq,
  patternLengthPpq,
  stepDurationPpq,
  stepStartPpq,
  swingShiftPpq,
} from '@/ui/step-sequencer/timing';

describe('stepDurationPpq', () => {
  it('maps resolutions to quarter-note PPQ fractions', () => {
    expect(stepDurationPpq('1/8')).toBe(0.5);
    expect(stepDurationPpq('1/16')).toBe(0.25);
    expect(stepDurationPpq('1/8T')).toBeCloseTo(1 / 3, 12);
    expect(stepDurationPpq('1/16T')).toBeCloseTo(1 / 6, 12);
  });

  it('flags triplet resolutions', () => {
    expect(isTripletResolution('1/8')).toBe(false);
    expect(isTripletResolution('1/16')).toBe(false);
    expect(isTripletResolution('1/8T')).toBe(true);
    expect(isTripletResolution('1/16T')).toBe(true);
  });
});

describe('swingShiftPpq', () => {
  it('never shifts even-indexed steps', () => {
    expect(swingShiftPpq(0, '1/16', 100)).toBe(0);
    expect(swingShiftPpq(2, '1/16', 100)).toBe(0);
    expect(swingShiftPpq(10, '1/8', 75)).toBe(0);
  });

  it('delays odd steps by up to a third of a step (100% = triplet feel)', () => {
    expect(swingShiftPpq(1, '1/16', 100)).toBeCloseTo(0.25 / 3, 12);
    expect(swingShiftPpq(1, '1/16', 50)).toBeCloseTo(0.25 / 6, 12);
    expect(swingShiftPpq(3, '1/8', 100)).toBeCloseTo(0.5 / 3, 12);
    expect(swingShiftPpq(1, '1/16', 0)).toBe(0);
  });

  it('ignores swing on triplet grids', () => {
    expect(swingShiftPpq(1, '1/8T', 100)).toBe(0);
    expect(swingShiftPpq(1, '1/16T', 100)).toBe(0);
  });

  it('clamps the swing amount to 0-100', () => {
    expect(swingShiftPpq(1, '1/16', 250)).toBeCloseTo(0.25 / 3, 12);
    expect(swingShiftPpq(1, '1/16', -10)).toBe(0);
  });
});

describe('stepStartPpq', () => {
  it('places straight steps on the regular grid', () => {
    expect(stepStartPpq(0, '1/16', 0)).toBe(0);
    expect(stepStartPpq(4, '1/16', 0)).toBe(1);
    expect(stepStartPpq(3, '1/8', 0)).toBe(1.5);
  });

  it('adds swing and per-step offsets', () => {
    expect(stepStartPpq(1, '1/16', 100)).toBeCloseTo(0.25 + 0.25 / 3, 12);
    expect(stepStartPpq(2, '1/16', 0, 0.25)).toBeCloseTo(0.5 + 0.0625, 12);
    expect(stepStartPpq(2, '1/16', 0, -0.25)).toBeCloseTo(0.5 - 0.0625, 12);
  });

  it('clamps the first step to the pattern origin on negative offsets', () => {
    expect(stepStartPpq(0, '1/16', 0, -0.5)).toBe(0);
  });
});

describe('nearestStepForPpq', () => {
  it('recovers exact step starts with zero offset', () => {
    expect(nearestStepForPpq(0, '1/16', 0, 16)).toEqual({ step: 0, offset: 0 });
    expect(nearestStepForPpq(1, '1/16', 0, 16)).toEqual({ step: 4, offset: 0 });
  });

  it('recovers swung step starts', () => {
    const swungStart = stepStartPpq(1, '1/16', 100);
    const snap = nearestStepForPpq(swungStart, '1/16', 100, 16);
    expect(snap?.step).toBe(1);
    expect(snap?.offset ?? 1).toBeCloseTo(0, 12);
  });

  it('round-trips per-step offsets', () => {
    const ppq = stepStartPpq(5, '1/16', 0, 0.25);
    const snap = nearestStepForPpq(ppq, '1/16', 0, 16);
    expect(snap?.step).toBe(5);
    expect(snap?.offset ?? 0).toBeCloseTo(0.25, 12);
  });

  it('clamps residual offsets to half a step', () => {
    const snap = nearestStepForPpq(0.17, '1/16', 100, 16);
    expect(snap).not.toBeNull();
    expect(Math.abs(snap?.offset ?? 1)).toBeLessThanOrEqual(0.5);
  });

  it('drops positions beyond the pattern end', () => {
    expect(nearestStepForPpq(4.2, '1/16', 0, 16)).toBeNull();
    expect(nearestStepForPpq(-0.1, '1/16', 0, 16)).toBeNull();
  });

  it('keeps positions just past the last step within half a step', () => {
    const snap = nearestStepForPpq(3.85, '1/16', 0, 16);
    expect(snap?.step).toBe(15);
    expect(snap?.offset ?? 0).toBeCloseTo(0.4, 12);
  });
});

describe('patternLengthPpq', () => {
  it('multiplies step count by step duration', () => {
    expect(patternLengthPpq(16, '1/16')).toBe(4);
    expect(patternLengthPpq(8, '1/8')).toBe(4);
    expect(patternLengthPpq(12, '1/8T')).toBeCloseTo(4, 12);
  });
});
