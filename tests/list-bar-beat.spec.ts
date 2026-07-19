import { describe, expect, it } from 'vitest';
import {
  barBeatFromPpq,
  barLengthPpq,
  beatLengthPpq,
  formatBarBeat,
  formatBarBeatTick,
  fractionalBarsBetween,
  parseBarBeat,
  parseBarBeatTick,
  ppqFromBarBeat,
  TICKS_PER_QUARTER,
} from '@/components/lists/bar-beat';
import type { TimeSignatureSegment } from '@/project/types';

const FOUR_FOUR: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 4, denominator: 4 }];

/** 2 bars of 4/4 (8 PPQ) then 6/8 (bar = 3 PPQ, beat = 0.5 PPQ). */
const MIXED: TimeSignatureSegment[] = [
  { startPpq: 0, numerator: 4, denominator: 4 },
  { startPpq: 8, numerator: 6, denominator: 8 },
];

describe('bar/beat lengths', () => {
  it('computes beat and bar lengths in quarter-note PPQ', () => {
    expect(beatLengthPpq({ denominator: 4 })).toBe(1);
    expect(beatLengthPpq({ denominator: 8 })).toBe(0.5);
    expect(barLengthPpq({ numerator: 4, denominator: 4 })).toBe(4);
    expect(barLengthPpq({ numerator: 6, denominator: 8 })).toBe(3);
    expect(barLengthPpq({ numerator: 3, denominator: 2 })).toBe(6);
  });
});

describe('barBeatFromPpq', () => {
  it('maps PPQ 0 to 1.1', () => {
    expect(barBeatFromPpq(0, FOUR_FOUR)).toEqual({ bar: 1, beat: 1 });
  });

  it('maps whole bars and fractional beats in 4/4', () => {
    expect(barBeatFromPpq(4, FOUR_FOUR)).toEqual({ bar: 2, beat: 1 });
    expect(barBeatFromPpq(5.5, FOUR_FOUR)).toEqual({ bar: 2, beat: 2.5 });
  });

  it('crosses meter changes with cumulative bar numbers', () => {
    expect(barBeatFromPpq(8, MIXED)).toEqual({ bar: 3, beat: 1 });
    expect(barBeatFromPpq(8.5, MIXED)).toEqual({ bar: 3, beat: 2 });
    expect(barBeatFromPpq(11, MIXED)).toEqual({ bar: 4, beat: 1 });
  });

  it('falls back to 4/4 when the meter map is empty', () => {
    expect(barBeatFromPpq(9, [])).toEqual({ bar: 3, beat: 2 });
  });

  it('clamps negative positions to 1.1', () => {
    expect(barBeatFromPpq(-3, FOUR_FOUR)).toEqual({ bar: 1, beat: 1 });
  });
});

describe('fractionalBarsBetween', () => {
  const THREE_FOUR: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 3, denominator: 4 }];

  it('counts whole and fractional bars in 4/4', () => {
    expect(fractionalBarsBetween(0, 8, FOUR_FOUR)).toBe(2);
    expect(fractionalBarsBetween(0, 4, FOUR_FOUR)).toBe(1);
    expect(fractionalBarsBetween(0, 6, FOUR_FOUR)).toBe(1.5);
  });

  it('respects a non-4/4 meter instead of a fixed 4 beats per bar', () => {
    // 3 bars of 3/4 span 9 PPQ; dividing by a fixed 4 would misread this as 2.
    expect(fractionalBarsBetween(0, 9, THREE_FOUR)).toBe(3);
    expect(fractionalBarsBetween(0, 6, THREE_FOUR)).toBe(2);
  });

  it('measures each portion against its own meter across a change', () => {
    // 2 bars of 4/4 (0..8) then 1 bar of 6/8 (8..11) = 3 bars.
    expect(fractionalBarsBetween(0, 11, MIXED)).toBe(3);
    expect(fractionalBarsBetween(8, 11, MIXED)).toBe(1);
    // Half a 6/8 bar (1.5 PPQ) past the change adds 0.5.
    expect(fractionalBarsBetween(0, 9.5, MIXED)).toBe(2.5);
  });

  it('returns 0 for an empty or inverted range', () => {
    expect(fractionalBarsBetween(5, 5, FOUR_FOUR)).toBe(0);
    expect(fractionalBarsBetween(8, 4, FOUR_FOUR)).toBe(0);
  });
});

describe('ppqFromBarBeat', () => {
  it('is the inverse of barBeatFromPpq across meter changes', () => {
    for (const ppq of [0, 1, 3.75, 8, 9.5, 14]) {
      expect(ppqFromBarBeat(barBeatFromPpq(ppq, MIXED), MIXED)).toBeCloseTo(ppq, 9);
    }
  });

  it('extends the last meter indefinitely', () => {
    // Bar 10 = bar 3 + 7 bars of 6/8 (3 PPQ each).
    expect(ppqFromBarBeat({ bar: 10, beat: 1 }, MIXED)).toBe(8 + 7 * 3);
  });
});

describe('formatBarBeat', () => {
  it('formats integral and fractional beats', () => {
    expect(formatBarBeat(0, FOUR_FOUR)).toBe('1.1');
    expect(formatBarBeat(5, FOUR_FOUR)).toBe('2.2');
    expect(formatBarBeat(5.5, FOUR_FOUR)).toBe('2.2.5');
  });

  it('carries a beat that rounds past the bar end into the next bar', () => {
    expect(formatBarBeat(3.9999999, FOUR_FOUR)).toBe('2.1');
  });
});

describe('parseBarBeat', () => {
  it('parses bar, bar.beat and bar.beat.fraction forms', () => {
    expect(parseBarBeat('1', FOUR_FOUR)).toBe(0);
    expect(parseBarBeat('1.1', FOUR_FOUR)).toBe(0);
    expect(parseBarBeat('2.2', FOUR_FOUR)).toBe(5);
    expect(parseBarBeat('2.2.5', FOUR_FOUR)).toBe(5.5);
    expect(parseBarBeat(' 3.1 ', FOUR_FOUR)).toBe(8);
  });

  it('parses positions under a later meter', () => {
    expect(parseBarBeat('4.1', MIXED)).toBe(11);
    expect(parseBarBeat('3.2', MIXED)).toBe(8.5);
  });

  it('rejects malformed and out-of-range positions', () => {
    expect(parseBarBeat('', FOUR_FOUR)).toBeNull();
    expect(parseBarBeat('abc', FOUR_FOUR)).toBeNull();
    expect(parseBarBeat('0.1', FOUR_FOUR)).toBeNull();
    expect(parseBarBeat('1.0', FOUR_FOUR)).toBeNull();
    expect(parseBarBeat('-2.1', FOUR_FOUR)).toBeNull();
    expect(parseBarBeat('1.5', FOUR_FOUR)).toBeNull(); // beat 5 does not exist in 4/4
    expect(parseBarBeat('3.7', MIXED)).toBeNull(); // beat 7 does not exist in 6/8
  });

  it('round-trips formatBarBeat output', () => {
    for (const ppq of [0, 2.25, 5.5, 8, 9.5, 20]) {
      const text = formatBarBeat(ppq, MIXED);
      expect(parseBarBeat(text, MIXED)).toBeCloseTo(ppq, 6);
    }
  });
});

describe('formatBarBeatTick', () => {
  it('formats bar.beat.sixteenth.tick with zero-padded ticks', () => {
    expect(formatBarBeatTick(0, FOUR_FOUR)).toBe('1.1.1.000');
    expect(formatBarBeatTick(5, FOUR_FOUR)).toBe('2.2.1.000');
    // Beat 2.5 in 4/4 → 240 ticks into the beat = sixteenth 3, tick 0.
    expect(formatBarBeatTick(5.5, FOUR_FOUR)).toBe('2.2.3.000');
    // A sixteenth offset: 60 ticks into the beat = sixteenth 1, tick 60.
    expect(formatBarBeatTick(4 + 60 / 480, FOUR_FOUR)).toBe('2.1.1.060');
  });

  it('carries a tick that rounds past the bar end into the next bar', () => {
    expect(formatBarBeatTick(3.9999999, FOUR_FOUR)).toBe('2.1.1.000');
  });

  it('formats positions under a later meter', () => {
    // PPQ 8.5 = bar 3 beat 2 in the 6/8 region (beat = 0.5 PPQ).
    expect(formatBarBeatTick(8.5, MIXED)).toBe('3.2.1.000');
  });
});

describe('parseBarBeatTick', () => {
  it('parses bar, bar.beat, bar.beat.16th and bar.beat.16th.tick forms', () => {
    expect(parseBarBeatTick('1', FOUR_FOUR)).toBe(0);
    expect(parseBarBeatTick('2.2', FOUR_FOUR)).toBe(5);
    expect(parseBarBeatTick('2.2.3', FOUR_FOUR)).toBeCloseTo(5.5, 9);
    expect(parseBarBeatTick('2.2.3.000', FOUR_FOUR)).toBeCloseTo(5.5, 9);
    expect(parseBarBeatTick(' 3.1.1.000 ', FOUR_FOUR)).toBe(8);
  });

  it('rejects malformed and out-of-range positions', () => {
    expect(parseBarBeatTick('', FOUR_FOUR)).toBeNull();
    expect(parseBarBeatTick('0.1', FOUR_FOUR)).toBeNull();
    expect(parseBarBeatTick('1.0', FOUR_FOUR)).toBeNull();
    expect(parseBarBeatTick('1.5.1', FOUR_FOUR)).toBeNull(); // beat 5 absent in 4/4
    expect(parseBarBeatTick('1.1.5', FOUR_FOUR)).toBeNull(); // 16th 5 absent in a 4/4 beat
    // tick out of the sixteenth's range (>= ticks per sixteenth).
    expect(parseBarBeatTick(`1.1.1.${TICKS_PER_QUARTER / 4}`, FOUR_FOUR)).toBeNull();
  });

  it('round-trips formatBarBeatTick output', () => {
    for (const ppq of [0, 2.25, 5.5, 8, 9.5, 20]) {
      const text = formatBarBeatTick(ppq, MIXED);
      expect(parseBarBeatTick(text, MIXED)).toBeCloseTo(ppq, 6);
    }
  });
});
