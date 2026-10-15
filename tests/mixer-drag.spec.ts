import { describe, expect, it } from 'vitest';
import { clampToRange } from '@/ui/mixer/drag';

const RANGE = { min: 0, max: 100 };

describe('clampToRange', () => {
  it('clamps below, above and inside the range', () => {
    expect(clampToRange(-5, RANGE)).toBe(0);
    expect(clampToRange(105, RANGE)).toBe(100);
    expect(clampToRange(42, RANGE)).toBe(42);
  });
});
