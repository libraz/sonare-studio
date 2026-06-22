import { describe, expect, it } from 'vitest';
import { MODE_OPTIONS, modeMaskFor, ROOT_OPTIONS, scaleName } from '@/ui/sample-editor/scales';

describe('modeMaskFor', () => {
  it('builds the major mask matching libsonare ScaleQuantizer default', () => {
    // 0b101010110101 — degrees {0,2,4,5,7,9,11} relative to the root.
    expect(modeMaskFor(0)).toBe(0b101010110101);
    expect(modeMaskFor(0)).toBe(2741);
  });

  it('builds the diatonic mode masks', () => {
    expect(modeMaskFor(1)).toBe(1453); // Minor  {0,2,3,5,7,8,10}
    expect(modeMaskFor(6)).toBe(1387); // Locrian {0,1,3,5,6,8,10}
  });

  it('falls back to major for an unknown ordinal', () => {
    expect(modeMaskFor(99)).toBe(modeMaskFor(0));
    expect(modeMaskFor(-1)).toBe(modeMaskFor(0));
  });
});

describe('scaleName', () => {
  it('combines the root pitch class and mode name', () => {
    expect(scaleName(0, 0)).toBe('C Major');
    expect(scaleName(9, 1)).toBe('A Minor');
    expect(scaleName(6, 4)).toBe('F# Lydian');
  });

  it('normalizes out-of-range roots and unknown modes', () => {
    expect(scaleName(12, 0)).toBe('C Major');
    expect(scaleName(0, 99)).toBe('C Major');
  });
});

describe('picker options', () => {
  it('offers twelve roots and seven modes keyed by ordinal', () => {
    expect(ROOT_OPTIONS).toHaveLength(12);
    expect(ROOT_OPTIONS[0]).toEqual({ value: '0', label: 'C' });
    expect(ROOT_OPTIONS[9]).toEqual({ value: '9', label: 'A' });
    expect(MODE_OPTIONS).toHaveLength(7);
    expect(MODE_OPTIONS[0]).toEqual({ value: '0', label: 'Major' });
    expect(MODE_OPTIONS[1]).toEqual({ value: '1', label: 'Minor' });
  });
});
