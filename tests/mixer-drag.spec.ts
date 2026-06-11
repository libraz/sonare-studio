import { describe, expect, it } from 'vitest';
import {
  applyDrag,
  clampToRange,
  DEFAULT_DRAG_PIXELS,
  dragDeltaValue,
  FINE_FACTOR,
  NUDGE_DIVISIONS,
  nudgeStep,
  nudgeValue,
} from '@/ui/mixer/drag';

const RANGE = { min: 0, max: 100 };

describe('dragDeltaValue', () => {
  it('sweeps the full range over the default pixel travel', () => {
    expect(dragDeltaValue(DEFAULT_DRAG_PIXELS, RANGE)).toBeCloseTo(100, 9);
    expect(dragDeltaValue(-DEFAULT_DRAG_PIXELS, RANGE)).toBeCloseTo(-100, 9);
  });

  it('scales with a custom pixel travel', () => {
    expect(dragDeltaValue(50, RANGE, { pixels: 100 })).toBeCloseTo(50, 9);
  });

  it('applies the fine factor', () => {
    const coarse = dragDeltaValue(30, RANGE);
    const fine = dragDeltaValue(30, RANGE, { fine: true });
    expect(fine).toBeCloseTo(coarse * FINE_FACTOR, 9);
  });

  it('is zero for no movement', () => {
    expect(dragDeltaValue(0, RANGE)).toBe(0);
  });
});

describe('applyDrag', () => {
  it('accumulates from the previous value', () => {
    const next = applyDrag(50, 15, RANGE, { pixels: 150 });
    expect(next).toBeCloseTo(60, 9);
  });

  it('clamps at the range bounds', () => {
    expect(applyDrag(95, 500, RANGE)).toBe(100);
    expect(applyDrag(5, -500, RANGE)).toBe(0);
  });

  it('supports asymmetric ranges', () => {
    const range = { min: -1, max: 1 };
    expect(applyDrag(0, DEFAULT_DRAG_PIXELS / 2, range)).toBeCloseTo(1, 9);
    expect(applyDrag(0.9, DEFAULT_DRAG_PIXELS, range)).toBe(1);
  });
});

describe('nudgeStep / nudgeValue', () => {
  it('divides the range into the configured coarse steps', () => {
    expect(nudgeStep(RANGE)).toBeCloseTo(100 / NUDGE_DIVISIONS, 9);
  });

  it('shrinks the step in fine mode', () => {
    expect(nudgeStep(RANGE, true)).toBeCloseTo((100 / NUDGE_DIVISIONS) * FINE_FACTOR, 9);
  });

  it('nudges in both directions and clamps', () => {
    const step = nudgeStep(RANGE);
    expect(nudgeValue(50, RANGE, 1)).toBeCloseTo(50 + step, 9);
    expect(nudgeValue(50, RANGE, -1)).toBeCloseTo(50 - step, 9);
    expect(nudgeValue(100, RANGE, 1)).toBe(100);
    expect(nudgeValue(0, RANGE, -1)).toBe(0);
  });
});

describe('clampToRange', () => {
  it('clamps to both bounds', () => {
    expect(clampToRange(-5, RANGE)).toBe(0);
    expect(clampToRange(105, RANGE)).toBe(100);
    expect(clampToRange(42, RANGE)).toBe(42);
  });
});
