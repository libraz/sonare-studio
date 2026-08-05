import { describe, expect, it } from 'vitest';
import { applyGrooveTemplate, extractGrooveTemplate } from '@/project/groove';

describe('groove templates', () => {
  it('extracts repeating grid offsets and applies them by strength', () => {
    const groove = extractGrooveTemplate(
      [{ startPpq: 0 }, { startPpq: 0.6 }, { startPpq: 1 }],
      0.5,
      4,
    );
    expect(groove.offsetsPpq[1]).toBeCloseTo(0.1);
    const out = applyGrooveTemplate(
      [{ id: 1, pitch: 60, velocity: 96, channel: 0, startPpq: 0.5, durationPpq: 0.5 }],
      groove,
      0.5,
    );
    expect(out[0].startPpq).toBeCloseTo(0.55);
  });
});
