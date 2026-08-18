/**
 * Full-grid pin of `strongBeatAt` verdicts: every sixteenth-note position of
 * three bars is rendered as `S` (strong) or `.` so a change in the meter
 * adapter shows up as a readable pattern diff instead of a single boolean.
 */

import { describe, expect, it } from 'vitest';
import { strongBeatAt } from '@/compose/meter';
import type { TimeSignatureSegment } from '@/project/types';

const SIXTEENTH_PPQ = 0.25;
const EIGHTH_PPQ = 0.5;

/** Renders strong-beat verdicts from PPQ zero to `endPpq` at a fixed step. */
function pattern(
  segments: ReadonlyArray<TimeSignatureSegment>,
  endPpq: number,
  stepPpq: number,
): string {
  let out = '';
  for (let ppq = 0; ppq < endPpq - 1e-9; ppq += stepPpq) {
    out += strongBeatAt(segments, ppq) ? 'S' : '.';
  }
  return out;
}

function meter(
  numerator: number,
  denominator: number,
  grouping?: number[],
): TimeSignatureSegment[] {
  return [{ startPpq: 0, numerator, denominator, ...(grouping ? { grouping } : {}) }];
}

describe('strongBeatAt grid', () => {
  it.each([
    ['4/4', meter(4, 4), 12, 'S.......S.......S.......S.......S.......S.......'],
    [
      '7/8 grouped 2+2+3',
      meter(7, 8, [2, 2, 3]),
      10.5,
      'S...S...S.....S...S...S.....S...S...S.....',
    ],
    [
      '5/4 grouped 3+2',
      meter(5, 4, [3, 2]),
      15,
      'S...........S.......S...........S.......S...........S.......',
    ],
    ['6/8 compound', meter(6, 8), 9, 'S.....S.....S.....S.....S.....S.....'],
    ['6/8 grouped 3+3', meter(6, 8, [3, 3]), 9, 'S.....S.....S.....S.....S.....S.....'],
    [
      // A grouping of equal-length groups only restates the division the meter
      // already has, so 9/8 as 1+1+1 reads as an ungrouped bar. Its three dotted
      // quarters are pulses, but none of them is the bar's midpoint, so the bar
      // has no secondary accent and only the downbeat is strong. Compare 6/8
      // below, where the second pulse is the midpoint and does carry one.
      '9/8 grouped 1+1+1 (states the meter, so no accent of its own)',
      meter(9, 8, [1, 1, 1]),
      13.5,
      'S.................S.................S.................',
    ],
    [
      '9/8 grouped 2+2+2+3 (unit reading)',
      meter(9, 8, [2, 2, 2, 3]),
      13.5,
      'S...S...S...S.....S...S...S...S.....S...S...S...S.....',
    ],
  ])('pins %s across three bars', (_label, segments, endPpq, expected) => {
    expect(pattern(segments, endPpq, SIXTEENTH_PPQ)).toBe(expected);
  });

  it.each([
    [
      'sum matches neither units nor pulses',
      meter(7, 8, [2, 2, 2]),
      10.5,
      'S.............S.............S.............',
    ],
    [
      'a group length is zero',
      meter(5, 4, [2, 0, 3]),
      15,
      'S...................S...................S...................',
    ],
    [
      'a group length is fractional',
      meter(5, 4, [2.5, 2.5]),
      15,
      'S...................S...................S...................',
    ],
    [
      'the grouping is empty',
      meter(4, 4, []),
      12,
      'S.......S.......S.......S.......S.......S.......',
    ],
  ])('falls back to the bare meter when %s', (_label, segments, endPpq, expected) => {
    // An unreadable grouping is dropped where the map is normalized, so the
    // segment still accents its downbeat (and 4/4 its midpoint) instead of
    // losing every accent it has.
    expect(pattern(segments, endPpq, SIXTEENTH_PPQ)).toBe(expected);
  });

  it('rebases the grid at every meter change', () => {
    // 4/4 from 0, then 7/8 (2+2+3) from 16, then 3/4 from 30. Group heads are
    // counted from each segment start, not from PPQ zero.
    const segments: TimeSignatureSegment[] = [
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 16, numerator: 7, denominator: 8, grouping: [2, 2, 3] },
      { startPpq: 30, numerator: 3, denominator: 4 },
    ];
    expect(pattern(segments, 39, EIGHTH_PPQ)).toBe(
      'S...S...S...S...S...S...S...S...S.S.S..S.S.S..S.S.S..S.S.S..S.....S.....S.....',
    );
  });

  it('clamps positions before the first segment to its downbeat', () => {
    expect(strongBeatAt(meter(4, 4), -1)).toBe(true);
    expect(strongBeatAt(meter(7, 8, [2, 2, 3]), -1)).toBe(true);
  });

  it('is not strong for a non-finite position', () => {
    expect(strongBeatAt(meter(4, 4), Number.NaN)).toBe(false);
    expect(strongBeatAt(meter(7, 8, [2, 2, 3]), Number.NaN)).toBe(false);
  });
});
