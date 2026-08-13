import { describe, expect, it } from 'vitest';
import {
  applyGrooveToPosition,
  extractGrooveTemplate,
  grooveOffsetPpq,
  grooveTemplateIsUsable,
} from '@/project/groove';

describe('groove templates', () => {
  it('averages the onset offset of every step of the period', () => {
    const groove = extractGrooveTemplate([0, 0.6, 1, 1.4], 0.5, 4);
    expect(groove.offsetsPpq[0]).toBeCloseTo(0);
    expect(groove.offsetsPpq[1]).toBeCloseTo(0.1);
    expect(groove.offsetsPpq[2]).toBeCloseTo(0);
    // 1.4 sits on step 3 (1.5) and drags it 0.1 early.
    expect(groove.offsetsPpq[3]).toBeCloseTo(-0.1);
  });

  it('repeats the template beyond one period and scales by strength', () => {
    const groove = { gridPpq: 0.5, offsetsPpq: [0, 0.1] };
    expect(grooveOffsetPpq(groove, 2.5)).toBeCloseTo(0.1);
    expect(applyGrooveToPosition(groove, 2.5, 0.5)).toBeCloseTo(2.55);
    expect(applyGrooveToPosition(groove, 2.5, 0)).toBe(2.5);
  });

  it('targets the nearest straight grid plus its offset and is idempotent at full strength', () => {
    const groove = { gridPpq: 0.5, offsetsPpq: [0, 0.1] };
    const first = applyGrooveToPosition(groove, 0.4);

    expect(first).toBeCloseTo(0.6);
    expect(applyGrooveToPosition(groove, 0.4, 0.5)).toBeCloseTo(0.5);
    expect(applyGrooveToPosition(groove, first)).toBeCloseTo(first);
  });

  it('reports templates that cannot move anything as unusable', () => {
    expect(grooveTemplateIsUsable(null)).toBe(false);
    expect(grooveTemplateIsUsable({ gridPpq: 0.5, offsetsPpq: [0, 0] })).toBe(false);
    expect(grooveTemplateIsUsable({ gridPpq: 0, offsetsPpq: [0.1] })).toBe(false);
    expect(grooveTemplateIsUsable({ gridPpq: 0.5, offsetsPpq: [0, 0.1] })).toBe(true);
  });
});
