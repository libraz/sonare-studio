import { describe, expect, it } from 'vitest';
import {
  expandExpressionPoints,
  sanitizeCcPoints,
  sanitizePressurePoints,
} from '@/project/midi-cc';

describe('clip expression points', () => {
  it('preserves supported non-hold curves and drops invalid/default curves while sanitizing', () => {
    expect(
      sanitizeCcPoints(
        [
          { ppq: 1, value: 128, curve: 'linear' },
          { ppq: 2, value: -1, curve: 'hold' },
          { ppq: 3, value: 64, curve: 'bogus' as never },
        ],
        2,
      ),
    ).toEqual([
      { ppq: 1, value: 127, curve: 'linear' },
      { ppq: 2, value: 64 },
    ]);

    expect(sanitizePressurePoints([{ ppq: 0, value: 32, curve: 'sCurve' }], 1)).toEqual([
      { ppq: 0, value: 32, curve: 'sCurve' },
    ]);
  });

  it('expands ramp curves into bounded intermediate MIDI values', () => {
    const expanded = expandExpressionPoints(
      [
        { ppq: 0, value: 0, curve: 'linear' },
        { ppq: 1, value: 127 },
      ],
      1,
      127,
    );

    expect(expanded[0]).toEqual({ ppq: 0, value: 0 });
    expect(expanded).toContainEqual({ ppq: 0.5, value: 64 });
    expect(expanded.at(-1)).toEqual({ ppq: 1, value: 127 });
    expect(expanded.length).toBeGreaterThan(2);
  });

  it('keeps hold curves as one event per breakpoint', () => {
    expect(
      expandExpressionPoints(
        [
          { ppq: 0, value: 0 },
          { ppq: 1, value: 127 },
        ],
        1,
        127,
      ),
    ).toEqual([
      { ppq: 0, value: 0 },
      { ppq: 1, value: 127 },
    ]);
  });
});
