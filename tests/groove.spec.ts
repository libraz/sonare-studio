import { describe, expect, it } from 'vitest';
import {
  applyGrooveToPosition,
  extractGrooveTemplate,
  grooveOffsetPpq,
  grooveTemplateIsUsable,
} from '@/project/groove';

describe('groove templates', () => {
  it('averages the onset offset of every step of the period', () => {
    const groove = extractGrooveTemplate([], [0, 0.6, 1, 1.4], 0.5, 4);
    expect(groove.offsetsPpq[0]).toBeCloseTo(0);
    expect(groove.offsetsPpq[1]).toBeCloseTo(0.1);
    expect(groove.offsetsPpq[2]).toBeCloseTo(0);
    // 1.4 sits on step 3 (1.5) and drags it 0.1 early.
    expect(groove.offsetsPpq[3]).toBeCloseTo(-0.1);
  });

  it('repeats the template beyond one period and scales by strength', () => {
    const groove = { gridPpq: 0.5, offsetsPpq: [0, 0.1] };
    expect(grooveOffsetPpq(groove, [], 2.5)).toBeCloseTo(0.1);
    expect(applyGrooveToPosition(groove, [], 2.5, 0.5)).toBeCloseTo(2.55);
    expect(applyGrooveToPosition(groove, [], 2.5, 0)).toBe(2.5);
  });

  it('targets the nearest straight grid plus its offset and is idempotent at full strength', () => {
    const groove = { gridPpq: 0.5, offsetsPpq: [0, 0.1] };
    const first = applyGrooveToPosition(groove, [], 0.4);

    expect(first).toBeCloseTo(0.6);
    expect(applyGrooveToPosition(groove, [], 0.4, 0.5)).toBeCloseTo(0.5);
    expect(applyGrooveToPosition(groove, [], first)).toBeCloseTo(first);
  });

  it('reports templates that cannot move anything as unusable', () => {
    expect(grooveTemplateIsUsable(null)).toBe(false);
    expect(grooveTemplateIsUsable({ gridPpq: 0.5, offsetsPpq: [0, 0] })).toBe(false);
    expect(grooveTemplateIsUsable({ gridPpq: 0, offsetsPpq: [0.1] })).toBe(false);
    expect(grooveTemplateIsUsable({ gridPpq: 0.5, offsetsPpq: [0, 0.1] })).toBe(true);
  });
});

describe('groove templates on the meter map', () => {
  /** Captures one onset per step of two bars, each pushed by its own metric offset. */
  function roundTrip(
    meter: Array<{ startPpq: number; numerator: number; denominator: number }>,
    gridPpq: number,
    barPpq: number,
  ): void {
    const stepsPerBar = Math.round(barPpq / gridPpq);
    const offsetAt = (step: number) => ((step % stepsPerBar) + 1) * 0.001;
    const onsets: number[] = [];
    for (let step = 0; step < stepsPerBar * 2; step += 1) {
      onsets.push(step * gridPpq + offsetAt(step));
    }
    const groove = extractGrooveTemplate(meter, onsets, gridPpq);
    for (let step = 0; step < stepsPerBar * 2; step += 1) {
      expect(applyGrooveToPosition(groove, meter, step * gridPpq)).toBeCloseTo(
        step * gridPpq + offsetAt(step),
        9,
      );
    }
  }

  it('keeps every 3/4 sixteenth on its own metric position', () => {
    roundTrip([{ startPpq: 0, numerator: 3, denominator: 4 }], 0.25, 3);
  });

  it('keeps every 4/4 eighth-triplet on its own metric position', () => {
    roundTrip([{ startPpq: 0, numerator: 4, denominator: 4 }], 1 / 3, 4);
  });

  it('counts steps from the bar after a meter change', () => {
    const meter = [
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 4, numerator: 3, denominator: 4 },
    ];
    const groove = { gridPpq: 0.25, offsetsPpq: Array.from({ length: 16 }, (_, i) => i * 0.001) };
    // Bar 3 starts at 7: its downbeat is step 0, not step 12 of a fixed period.
    expect(grooveOffsetPpq(groove, meter, 7)).toBe(0);
    expect(grooveOffsetPpq(groove, meter, 7.25)).toBeCloseTo(0.001, 12);
  });
});
