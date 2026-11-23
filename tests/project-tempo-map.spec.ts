import { describe, expect, it } from 'vitest';
import {
  canonicalTempoMap,
  normalizeTempoMap,
  ppqDurationSamples,
  ppqDurationSeconds,
  ppqRangeSamples,
  ppqRangeSeconds,
  ppqToSamples,
  ppqToSeconds,
  samplesToPpq,
  secondsToPpq,
  tempoAtPpq,
} from '@/project/tempo-map';
import { translateTempoMapForExport } from '@/project/tempo-map-export';
import type { TempoSegment } from '@/project/types';

/** Render rate used by the sample-conversion tests. */
const SAMPLE_RATE = 48000;

/** Constant 120 BPM map (1 PPQ = 0.5 s; 24000 samples at 48 kHz). */
const CONSTANT_120: TempoSegment[] = [{ startPpq: 0, bpm: 120 }];

/** Two constant segments: 120 BPM until ppq 4, then 60 BPM. */
const STEP_120_60: TempoSegment[] = [
  { startPpq: 0, bpm: 120 },
  { startPpq: 4, bpm: 60 },
];

/** Linear ramp 120 -> 60 BPM across ppq [0, 4], then constant 60 BPM. */
const RAMP_120_60: TempoSegment[] = [
  { startPpq: 0, bpm: 120, endBpm: 60 },
  { startPpq: 4, bpm: 60 },
];

describe('tempo map conversions', () => {
  describe('constant single segment', () => {
    it('converts PPQ to seconds at 120 BPM (1 ppq = 0.5 s)', () => {
      const map = normalizeTempoMap(CONSTANT_120);
      expect(ppqToSeconds(map, 0)).toBe(0);
      expect(ppqToSeconds(map, 1)).toBe(0.5);
      expect(ppqToSeconds(map, 4)).toBe(2);
    });

    it('converts PPQ to samples at 48 kHz (24000 samples per ppq)', () => {
      const map = normalizeTempoMap(CONSTANT_120);
      expect(ppqToSamples(map, 1, SAMPLE_RATE)).toBe(24000);
      expect(ppqToSamples(map, 4, SAMPLE_RATE)).toBe(96000);
    });

    it('inverts seconds and samples back to PPQ', () => {
      const map = normalizeTempoMap(CONSTANT_120);
      expect(secondsToPpq(map, 0.5)).toBe(1);
      expect(samplesToPpq(map, 96000, SAMPLE_RATE)).toBe(4);
    });
  });

  describe('multiple constant segments', () => {
    it('accumulates seconds across the segment boundary', () => {
      const map = normalizeTempoMap(STEP_120_60);
      // 4 ppq at 120 BPM (2 s) + 2 ppq at 60 BPM (2 s).
      expect(ppqToSeconds(map, 4)).toBe(2);
      expect(ppqToSeconds(map, 6)).toBe(4);
    });

    it('computes anchored duration deltas across a tempo change', () => {
      const map = normalizeTempoMap(STEP_120_60);
      expect(ppqRangeSeconds(map, 3, 5)).toBe(1.5);
      expect(ppqDurationSeconds(map, 3, 2)).toBe(1.5);
      expect(ppqRangeSamples(map, 3, 5, SAMPLE_RATE)).toBe(72_000);
      expect(ppqDurationSamples(map, 3, 2, SAMPLE_RATE)).toBe(72_000);
    });

    it('round-trips PPQ through samples', () => {
      const map = normalizeTempoMap(STEP_120_60);
      for (const ppq of [0, 1, 4, 6, 10]) {
        expect(samplesToPpq(map, ppqToSamples(map, ppq, SAMPLE_RATE), SAMPLE_RATE)).toBeCloseTo(
          ppq,
          6,
        );
      }
    });
  });

  describe('ramped segment', () => {
    it('integrates the closed-form ramp time', () => {
      const map = normalizeTempoMap(RAMP_120_60);
      // slope = (60 - 120) / 4 = -15; t(4) = (60 / slope) * ln(60 / 120).
      const slope = -15;
      expect(ppqToSeconds(map, 4)).toBeCloseTo((60 / slope) * Math.log(60 / 120), 10);
      expect(ppqToSeconds(map, 4)).toBeCloseTo(2.77259, 5);
    });

    it('round-trips secondsToPpq(ppqToSeconds(x)) inside and past the ramp', () => {
      const map = normalizeTempoMap(RAMP_120_60);
      for (const ppq of [1, 2.5, 4, 6]) {
        expect(secondsToPpq(map, ppqToSeconds(map, ppq))).toBeCloseTo(ppq, 9);
      }
    });

    it('interpolates the instantaneous tempo linearly in PPQ', () => {
      const map = normalizeTempoMap(RAMP_120_60);
      // bpm(p) = bpm0 + slope * dp with slope = -15.
      expect(tempoAtPpq(map, 0)).toBe(120);
      expect(tempoAtPpq(map, 2)).toBe(120 + -15 * 2);
      expect(tempoAtPpq(map, 4)).toBe(60);
      expect(tempoAtPpq(map, 100)).toBe(60);
    });
  });

  describe('ramp eligibility', () => {
    it('ignores endBpm on the last segment (its end is open)', () => {
      const map = normalizeTempoMap([{ startPpq: 0, bpm: 120, endBpm: 60 }]);
      expect(ppqToSeconds(map, 4)).toBe(2);
      expect(tempoAtPpq(map, 4)).toBe(120);
    });

    it('treats an endBpm equal to bpm as constant', () => {
      const map = normalizeTempoMap([
        { startPpq: 0, bpm: 120, endBpm: 120 },
        { startPpq: 4, bpm: 60 },
      ]);
      expect(ppqToSeconds(map, 4)).toBe(2);
      expect(tempoAtPpq(map, 2)).toBe(120);
    });
  });

  describe('edge cases', () => {
    it('falls back to 120 BPM on empty input', () => {
      const map = normalizeTempoMap([]);
      expect(ppqToSeconds(map, 1)).toBe(0.5);
      expect(tempoAtPpq(map, 0)).toBe(120);
    });

    it('extrapolates linearly before the first segment (negative ppq)', () => {
      const map = normalizeTempoMap(CONSTANT_120);
      expect(ppqToSeconds(map, -2)).toBe(-1);
      expect(secondsToPpq(map, -1)).toBe(-2);
    });
  });

  describe('corrupt segment input', () => {
    it('drops entries with a non-finite startPpq', () => {
      const map = normalizeTempoMap([
        { startPpq: Number.NaN, bpm: 200 },
        { startPpq: Number.POSITIVE_INFINITY, bpm: 30 },
        { startPpq: 0, bpm: 120 },
      ]);
      expect(map.segments).toHaveLength(1);
      expect(ppqToSeconds(map, 1)).toBe(0.5);
    });

    it('falls back to 120 BPM when every entry is unusable', () => {
      const map = normalizeTempoMap([{ startPpq: Number.NaN, bpm: 200 }]);
      expect(tempoAtPpq(map, 0)).toBe(120);
      expect(ppqToSeconds(map, 1)).toBe(0.5);
    });

    it('replaces a non-finite bpm with the fallback tempo', () => {
      expect(tempoAtPpq(normalizeTempoMap([{ startPpq: 0, bpm: Number.NaN }]), 0)).toBe(120);
      expect(
        tempoAtPpq(normalizeTempoMap([{ startPpq: 0, bpm: Number.POSITIVE_INFINITY }], 90), 0),
      ).toBe(90);
    });

    it('reverts an invalid fallback tempo to 120 BPM', () => {
      expect(ppqToSeconds(normalizeTempoMap([], Number.NaN), 1)).toBe(0.5);
      expect(ppqToSeconds(normalizeTempoMap([], -5), 1)).toBe(0.5);
    });

    it('clamps a non-positive bpm to the engine floor instead of dividing by zero', () => {
      const zero = normalizeTempoMap([{ startPpq: 0, bpm: 0 }]);
      const negative = normalizeTempoMap([{ startPpq: 0, bpm: -50 }]);
      expect(tempoAtPpq(zero, 0)).toBe(1e-6);
      expect(tempoAtPpq(negative, 0)).toBe(1e-6);
      expect(Number.isFinite(ppqToSeconds(zero, 1))).toBe(true);
    });

    it('treats a non-finite or non-positive endBpm as a constant segment', () => {
      for (const endBpm of [Number.POSITIVE_INFINITY, Number.NaN, -10, 0]) {
        const map = normalizeTempoMap([
          { startPpq: 0, bpm: 120, endBpm },
          { startPpq: 4, bpm: 60 },
        ]);
        expect(tempoAtPpq(map, 2)).toBe(120);
        expect(ppqToSeconds(map, 4)).toBe(2);
      }
    });

    it('sorts segments given out of order', () => {
      const map = normalizeTempoMap([
        { startPpq: 4, bpm: 60 },
        { startPpq: 0, bpm: 120 },
      ]);
      expect(ppqToSeconds(map, 4)).toBe(2);
      expect(ppqToSeconds(map, 6)).toBe(4);
    });

    it('does not divide by zero when two segments share a startPpq', () => {
      const map = normalizeTempoMap([
        { startPpq: 0, bpm: 120, endBpm: 60 },
        { startPpq: 0, bpm: 90 },
      ]);
      const seconds = ppqToSeconds(map, 4);
      expect(Number.isNaN(seconds)).toBe(false);
      expect(Number.isFinite(seconds)).toBe(true);
    });
  });
});

describe('translateTempoMapForExport', () => {
  const meters = [
    { startPpq: 0, numerator: 4, denominator: 4 },
    { startPpq: 8, numerator: 3, denominator: 4 },
    { startPpq: 20, numerator: 6, denominator: 8 },
  ];

  it('rebases tempo and meter to the offset', () => {
    const out = translateTempoMapForExport(
      [
        { startPpq: 0, bpm: 100 },
        { startPpq: 10, bpm: 140 },
        { startPpq: 30, bpm: 90 },
      ],
      meters,
      12,
    );
    expect(out.tempoSegments).toEqual([
      { startPpq: 0, bpm: 140 },
      { startPpq: 18, bpm: 90 },
    ]);
    expect(out.timeSignatures.map((m) => [m.startPpq, m.numerator])).toEqual([
      [0, 3],
      [8, 6],
    ]);
  });

  it('starts a ramp in progress at its interpolated tempo', () => {
    const out = translateTempoMapForExport(
      [
        { startPpq: 0, bpm: 100, endBpm: 140 },
        { startPpq: 40, bpm: 140 },
      ],
      meters,
      20,
    );
    expect(out.tempoSegments).toEqual([
      { startPpq: 0, bpm: 120, endBpm: 140 },
      { startPpq: 20, bpm: 140 },
    ]);
  });

  it('never ramps the final segment', () => {
    const out = translateTempoMapForExport([{ startPpq: 0, bpm: 100, endBpm: 160 }], meters);
    expect(out.tempoSegments).toEqual([{ startPpq: 0, bpm: 100 }]);
  });

  it('holds the first tempo before a later first segment', () => {
    const out = translateTempoMapForExport([{ startPpq: 16, bpm: 90 }], meters, 4);
    expect(out.tempoSegments).toEqual([
      { startPpq: 0, bpm: 90 },
      { startPpq: 12, bpm: 90 },
    ]);
  });
});

describe('canonicalTempoMap', () => {
  it('merges an equal constant tempo and a ramp that carries on at the same slope', () => {
    const plain = normalizeTempoMap([
      { startPpq: 0, bpm: 120 },
      { startPpq: 8, bpm: 100, endBpm: 140 },
      { startPpq: 16, bpm: 140 },
    ]);
    const noisy = normalizeTempoMap([
      { startPpq: 0, bpm: 120 },
      { startPpq: 4, bpm: 120 },
      { startPpq: 8, bpm: 100, endBpm: 120 },
      { startPpq: 12, bpm: 120, endBpm: 140 },
      { startPpq: 16, bpm: 140 },
    ]);
    expect(
      canonicalTempoMap(noisy).segments.map(({ startPpq, bpm, slope }) => [startPpq, bpm, slope]),
    ).toEqual(
      canonicalTempoMap(plain).segments.map(({ startPpq, bpm, slope }) => [startPpq, bpm, slope]),
    );
  });

  it('keeps a breakpoint that restarts a ramp or ends it', () => {
    const map = normalizeTempoMap([
      { startPpq: 0, bpm: 100, endBpm: 140 },
      { startPpq: 8, bpm: 100, endBpm: 140 },
      { startPpq: 16, bpm: 140 },
    ]);
    expect(canonicalTempoMap(map).segments.map((segment) => segment.startPpq)).toEqual([0, 8, 16]);
  });
});
