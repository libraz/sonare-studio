import { describe, expect, it } from 'vitest';
import {
  controlPercent,
  knobRotationDeg,
  knobValueForDrag,
  valueAtControlPercent,
} from '@/ui/devices/knob-math';

describe('device knob math', () => {
  it('maps frequency ranges logarithmically when requested', () => {
    expect(controlPercent(200, 20, 20000, 'log')).toBeCloseTo(1 / 3, 9);
    expect(valueAtControlPercent(1 / 3, 20, 20000, 'log')).toBeCloseTo(200, 9);
    expect(knobValueForDrag(20, -50, 20, 20000, false, 'log')).toBeCloseTo(200, 9);
    expect(knobRotationDeg(200, 20, 20000, 'log')).toBeCloseTo(-45, 9);
  });

  it('retains the linear mapping for zero-based controls', () => {
    expect(knobValueForDrag(0, -75, 0, 10, false, 'log')).toBe(5);
  });
});
