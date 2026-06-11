import { describe, expect, it } from 'vitest';
import {
  MAX_BPM,
  MIN_BPM,
  mergeTempoSegments,
  mergeTimeSignatureSegments,
  sortSegments,
  validateTempoRows,
  validateTimeSignatureRows,
} from '@/components/lists/row-validation';

describe('validateTempoRows', () => {
  it('accepts a valid ascending map anchored at 1.1', () => {
    expect(
      validateTempoRows([
        { startPpq: 0, bpm: 120 },
        { startPpq: 8, bpm: 90, endBpm: 140 },
        { startPpq: 16, bpm: 140 },
      ]),
    ).toEqual([]);
  });

  it('rejects an empty list', () => {
    const issues = validateTempoRows([]);
    expect(issues).toHaveLength(1);
    expect(issues[0].row).toBe(-1);
  });

  it('requires the first entry to start at PPQ 0', () => {
    const issues = validateTempoRows([{ startPpq: 4, bpm: 120 }]);
    expect(issues).toEqual([{ row: 0, message: 'The first entry must start at 1.1' }]);
  });

  it('rejects duplicate and descending positions', () => {
    const issues = validateTempoRows([
      { startPpq: 0, bpm: 120 },
      { startPpq: 8, bpm: 100 },
      { startPpq: 8, bpm: 110 },
      { startPpq: 4, bpm: 130 },
    ]);
    expect(issues.map((i) => i.row)).toEqual([2, 3]);
  });

  it('enforces the BPM range on bpm and endBpm', () => {
    expect(validateTempoRows([{ startPpq: 0, bpm: MIN_BPM }])).toEqual([]);
    expect(validateTempoRows([{ startPpq: 0, bpm: MAX_BPM }])).toEqual([]);
    expect(validateTempoRows([{ startPpq: 0, bpm: MIN_BPM - 1 }])).toHaveLength(1);
    expect(validateTempoRows([{ startPpq: 0, bpm: MAX_BPM + 1 }])).toHaveLength(1);
    expect(validateTempoRows([{ startPpq: 0, bpm: Number.NaN }])).toHaveLength(1);
    expect(validateTempoRows([{ startPpq: 0, bpm: 120, endBpm: 500 }])).toHaveLength(1);
    expect(validateTempoRows([{ startPpq: 0, bpm: 120, endBpm: 10 }])).toHaveLength(1);
  });

  it('rejects negative and non-finite positions', () => {
    expect(validateTempoRows([{ startPpq: Number.NaN, bpm: 120 }]).length).toBeGreaterThan(0);
    const issues = validateTempoRows([
      { startPpq: 0, bpm: 120 },
      { startPpq: -1, bpm: 120 },
    ]);
    expect(issues.some((i) => i.row === 1)).toBe(true);
  });
});

describe('validateTimeSignatureRows', () => {
  it('accepts a valid map', () => {
    expect(
      validateTimeSignatureRows([
        { startPpq: 0, numerator: 4, denominator: 4 },
        { startPpq: 8, numerator: 6, denominator: 8 },
      ]),
    ).toEqual([]);
  });

  it('rejects an empty list', () => {
    expect(validateTimeSignatureRows([])[0].row).toBe(-1);
  });

  it('rejects non-integer or out-of-range numerators', () => {
    expect(validateTimeSignatureRows([{ startPpq: 0, numerator: 0, denominator: 4 }])).toHaveLength(
      1,
    );
    expect(
      validateTimeSignatureRows([{ startPpq: 0, numerator: 33, denominator: 4 }]),
    ).toHaveLength(1);
    expect(
      validateTimeSignatureRows([{ startPpq: 0, numerator: 2.5, denominator: 4 }]),
    ).toHaveLength(1);
  });

  it('rejects denominators outside {1, 2, 4, 8, 16}', () => {
    expect(validateTimeSignatureRows([{ startPpq: 0, numerator: 4, denominator: 3 }])).toHaveLength(
      1,
    );
    expect(
      validateTimeSignatureRows([{ startPpq: 0, numerator: 4, denominator: 32 }]),
    ).toHaveLength(1);
    for (const denominator of [1, 2, 4, 8, 16]) {
      expect(validateTimeSignatureRows([{ startPpq: 0, numerator: 4, denominator }])).toEqual([]);
    }
  });

  it('requires strictly ascending positions', () => {
    const issues = validateTimeSignatureRows([
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 0, numerator: 3, denominator: 4 },
    ]);
    expect(issues).toEqual([{ row: 1, message: 'Positions must be strictly ascending' }]);
  });
});

describe('sortSegments', () => {
  it('returns a sorted copy without mutating the input', () => {
    const rows = [
      { startPpq: 8, bpm: 100 },
      { startPpq: 0, bpm: 120 },
    ];
    const sorted = sortSegments(rows);
    expect(sorted.map((r) => r.startPpq)).toEqual([0, 8]);
    expect(rows[0].startPpq).toBe(8);
  });
});

describe('mergeTempoSegments', () => {
  it('drops constant segments that restate the current tempo', () => {
    expect(
      mergeTempoSegments([
        { startPpq: 0, bpm: 120 },
        { startPpq: 4, bpm: 120 },
        { startPpq: 8, bpm: 90 },
      ]),
    ).toEqual([
      { startPpq: 0, bpm: 120 },
      { startPpq: 8, bpm: 90 },
    ]);
  });

  it('keeps segments that start a ramp even at the same BPM', () => {
    const segments = [
      { startPpq: 0, bpm: 120 },
      { startPpq: 4, bpm: 120, endBpm: 90 },
    ];
    expect(mergeTempoSegments(segments)).toEqual(segments);
  });

  it('keeps the segment that pins a ramp end', () => {
    const segments = [
      { startPpq: 0, bpm: 120, endBpm: 90 },
      { startPpq: 8, bpm: 90 },
    ];
    expect(mergeTempoSegments(segments)).toEqual(segments);
  });
});

describe('mergeTimeSignatureSegments', () => {
  it('drops segments equal to the meter in effect', () => {
    expect(
      mergeTimeSignatureSegments([
        { startPpq: 0, numerator: 4, denominator: 4 },
        { startPpq: 8, numerator: 4, denominator: 4 },
        { startPpq: 16, numerator: 6, denominator: 8 },
        { startPpq: 24, numerator: 4, denominator: 4 },
      ]),
    ).toEqual([
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 16, numerator: 6, denominator: 8 },
      { startPpq: 24, numerator: 4, denominator: 4 },
    ]);
  });
});
