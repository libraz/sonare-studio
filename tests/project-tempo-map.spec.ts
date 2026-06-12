import { describe, expect, it } from 'vitest';
import {
  normalizeTempoMap,
  ppqToSamples,
  ppqToSeconds,
  samplesToPpq,
  secondsToPpq,
  tempoAtPpq,
} from '@/project/tempo-map';
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
});
