import { describe, expect, it } from 'vitest';
import { euclideanRhythm } from '@/ui/step-sequencer/euclid';

/** Renders a boolean pattern as an x/. string for readable assertions. */
function render(pattern: boolean[]): string {
  return pattern.map((on) => (on ? 'x' : '.')).join('');
}

describe('euclideanRhythm', () => {
  it('produces the canonical E(3, 8) tresillo', () => {
    expect(render(euclideanRhythm(3, 8))).toBe('x..x..x.');
  });

  it('produces the canonical E(5, 8) cinquillo', () => {
    expect(render(euclideanRhythm(5, 8))).toBe('x.xx.xx.');
  });

  it('produces the four-on-the-floor E(4, 16)', () => {
    expect(render(euclideanRhythm(4, 16))).toBe('x...x...x...x...');
  });

  it('handles the degenerate fills', () => {
    expect(render(euclideanRhythm(0, 8))).toBe('........');
    expect(render(euclideanRhythm(8, 8))).toBe('xxxxxxxx');
    expect(render(euclideanRhythm(1, 4))).toBe('x...');
    expect(render(euclideanRhythm(1, 1))).toBe('x');
  });

  it('always places exactly `pulses` onsets', () => {
    for (let steps = 1; steps <= 32; steps++) {
      for (let pulses = 0; pulses <= steps; pulses++) {
        const onsets = euclideanRhythm(pulses, steps).filter(Boolean).length;
        expect(onsets).toBe(pulses);
      }
    }
  });

  it('distributes onsets evenly (gap lengths differ by at most one)', () => {
    for (const [pulses, steps] of [
      [3, 8],
      [5, 8],
      [5, 16],
      [7, 16],
      [9, 32],
    ] as const) {
      const pattern = euclideanRhythm(pulses, steps);
      const positions = pattern.flatMap((on, i) => (on ? [i] : []));
      const gaps = positions.map((pos, i) => {
        const next = positions[(i + 1) % positions.length];
        return (next - pos + steps) % steps || steps;
      });
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
    }
  });

  it('rotates onsets toward later steps for positive rotation', () => {
    expect(render(euclideanRhythm(3, 8, 1))).toBe('.x..x..x');
    expect(render(euclideanRhythm(3, 8, -1))).toBe('..x..x.x');
  });

  it('wraps rotation modulo the step count', () => {
    expect(euclideanRhythm(3, 8, 8)).toEqual(euclideanRhythm(3, 8));
    expect(euclideanRhythm(3, 8, 9)).toEqual(euclideanRhythm(3, 8, 1));
    expect(euclideanRhythm(3, 8, -7)).toEqual(euclideanRhythm(3, 8, 1));
  });

  it('rejects invalid arguments', () => {
    expect(() => euclideanRhythm(1, 0)).toThrow(RangeError);
    expect(() => euclideanRhythm(-1, 8)).toThrow(RangeError);
    expect(() => euclideanRhythm(9, 8)).toThrow(RangeError);
    expect(() => euclideanRhythm(1.5, 8)).toThrow(RangeError);
    expect(() => euclideanRhythm(3, 8, 0.5)).toThrow(RangeError);
  });
});
