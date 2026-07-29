import { describe, expect, it } from 'vitest';
import {
  barsInSpan,
  DEFAULT_OFF_VELOCITY,
  formatLaneValue,
  LANE_PARAMS,
  type LaneBar,
  laneBarRect,
  laneParamSpec,
  laneUpdateForValue,
  laneValueFromNormalized,
  laneValueFromY,
  normalizedLaneValue,
  noteLaneValue,
  quantizeLaneValue,
  rampValueAt,
} from '@/components/piano-roll/lane-params';
import type { EditorNote } from '@/project/types';

/** Builds an editor note with sensible defaults. */
function makeNote(partial: Partial<EditorNote> & { id: number }): EditorNote {
  return {
    pitch: 60,
    velocity: 96,
    startPpq: 1,
    durationPpq: 1,
    channel: 0,
    ...partial,
  };
}

/** Builds a lane bar column. */
function makeBar(id: number, x: number, w = 6): LaneBar {
  return { id, x, w };
}

describe('LANE_PARAMS', () => {
  it('lists the five parameters in tab order', () => {
    expect(LANE_PARAMS.map((spec) => spec.id)).toEqual([
      'velocity',
      'length',
      'offset',
      'offVelocity',
      'channel',
    ]);
  });

  it('marks offset as the only bipolar parameter', () => {
    expect(LANE_PARAMS.filter((spec) => spec.bipolar).map((spec) => spec.id)).toEqual(['offset']);
  });

  it('marks velocity, off-velocity and channel as stepped', () => {
    expect(LANE_PARAMS.filter((spec) => spec.stepped).map((spec) => spec.id)).toEqual([
      'velocity',
      'offVelocity',
      'channel',
    ]);
  });

  it('resolves specs by id', () => {
    expect(laneParamSpec('channel')).toMatchObject({ id: 'channel', min: 0, max: 15 });
  });
});

describe('noteLaneValue', () => {
  it('reads velocity, length and channel directly', () => {
    const note = makeNote({ id: 1, velocity: 42, durationPpq: 2.5, channel: 9 });
    expect(noteLaneValue('velocity', note)).toBe(42);
    expect(noteLaneValue('length', note)).toBe(2.5);
    expect(noteLaneValue('channel', note)).toBe(9);
  });

  it('reads offset as the signed deviation from the nearest sixteenth', () => {
    expect(noteLaneValue('offset', makeNote({ id: 1, startPpq: 4.125 }))).toBeCloseTo(-0.125, 9);
    expect(noteLaneValue('offset', makeNote({ id: 1, startPpq: 3.75 }))).toBe(0);
    expect(noteLaneValue('offset', makeNote({ id: 1, startPpq: 2 }))).toBe(0);
  });

  it('falls back to the default off-velocity when the note omits the field', () => {
    expect(noteLaneValue('offVelocity', makeNote({ id: 1 }))).toBe(DEFAULT_OFF_VELOCITY);
    expect(noteLaneValue('offVelocity', makeNote({ id: 1, offVelocity: 80 }))).toBe(80);
  });
});

describe('normalizedLaneValue', () => {
  it('keeps the historical velocity/127 bar mapping', () => {
    expect(normalizedLaneValue('velocity', 127)).toBe(1);
    expect(normalizedLaneValue('velocity', 64)).toBeCloseTo(64 / 127, 9);
  });

  it('maps length logarithmically between 1/64 note and four bars', () => {
    expect(normalizedLaneValue('length', 0.0625)).toBe(0);
    expect(normalizedLaneValue('length', 16)).toBe(1);
    // 1 beat is the geometric mean of the range (0.0625 * 256^0.5).
    expect(normalizedLaneValue('length', 1)).toBeCloseTo(0.5, 9);
  });

  it('clamps out-of-range lengths', () => {
    expect(normalizedLaneValue('length', 0.001)).toBe(0);
    expect(normalizedLaneValue('length', 64)).toBe(1);
  });

  it('maps offset bipolar around zero', () => {
    expect(normalizedLaneValue('offset', 0.5)).toBe(1);
    expect(normalizedLaneValue('offset', -0.5)).toBe(-1);
    expect(normalizedLaneValue('offset', 0)).toBe(0);
    expect(normalizedLaneValue('offset', 0.25)).toBeCloseTo(0.5, 9);
    expect(normalizedLaneValue('offset', 2)).toBe(1);
  });

  it('maps channel linearly across 0..15', () => {
    expect(normalizedLaneValue('channel', 0)).toBe(0);
    expect(normalizedLaneValue('channel', 15)).toBe(1);
  });
});

describe('laneValueFromNormalized', () => {
  it('round-trips length through the log scale', () => {
    for (const value of [0.0625, 0.25, 1, 3, 16]) {
      expect(laneValueFromNormalized('length', normalizedLaneValue('length', value))).toBeCloseTo(
        value,
        9,
      );
    }
  });

  it('rounds stepped parameters and clamps to range', () => {
    expect(laneValueFromNormalized('velocity', 0.5)).toBe(64);
    expect(laneValueFromNormalized('velocity', -1)).toBe(1);
    expect(laneValueFromNormalized('velocity', 2)).toBe(127);
    expect(laneValueFromNormalized('channel', 0.5)).toBe(8);
    expect(laneValueFromNormalized('channel', 1)).toBe(15);
  });

  it('maps bipolar offset without stepping', () => {
    expect(laneValueFromNormalized('offset', 0.5)).toBeCloseTo(0.25, 9);
    expect(laneValueFromNormalized('offset', -2)).toBe(-0.5);
  });
});

describe('laneValueFromY', () => {
  it('matches the historical velocity-from-y mapping', () => {
    // Legacy formula: min(127, max(1, round((1 - y / heightPx) * 127))).
    const legacy = (y: number, h: number): number =>
      Math.min(127, Math.max(1, Math.round((1 - y / h) * 127)));
    for (const y of [-10, 0, 25, 50, 75, 100, 120]) {
      expect(laneValueFromY('velocity', y, 100)).toBe(legacy(y, 100));
    }
  });

  it('maps bipolar offset with the center line at zero', () => {
    expect(laneValueFromY('offset', 0, 100)).toBe(0.5);
    expect(laneValueFromY('offset', 50, 100)).toBe(0);
    expect(laneValueFromY('offset', 100, 100)).toBe(-0.5);
    expect(laneValueFromY('offset', 200, 100)).toBe(-0.5);
  });

  it('steps channel values across the lane height', () => {
    expect(laneValueFromY('channel', 0, 100)).toBe(15);
    expect(laneValueFromY('channel', 50, 100)).toBe(8);
    expect(laneValueFromY('channel', 100, 100)).toBe(0);
  });

  it('returns the default value when the lane has no height', () => {
    expect(laneValueFromY('velocity', 10, 0)).toBe(96);
    expect(laneValueFromY('offset', 10, 0)).toBe(0);
  });
});

describe('quantizeLaneValue', () => {
  it('rounds stepped parameters', () => {
    expect(quantizeLaneValue('channel', 7.4)).toBe(7);
    expect(quantizeLaneValue('velocity', 99.6)).toBe(100);
  });

  it('clamps every parameter into range', () => {
    expect(quantizeLaneValue('channel', 20)).toBe(15);
    expect(quantizeLaneValue('channel', -3)).toBe(0);
    expect(quantizeLaneValue('length', 100)).toBe(16);
    expect(quantizeLaneValue('offset', 0.9)).toBe(0.5);
  });

  it('keeps continuous parameters unrounded', () => {
    expect(quantizeLaneValue('length', 1.337)).toBeCloseTo(1.337, 9);
    expect(quantizeLaneValue('offset', -0.125)).toBeCloseTo(-0.125, 9);
  });
});

describe('laneBarRect', () => {
  it('keeps the historical velocity bar geometry', () => {
    // Legacy: barH = max(2, (velocity / 127) * (heightPx - 2)), bottom-anchored.
    const full = laneBarRect('velocity', 127, 100);
    expect(full).toEqual({ y: 2, h: 98 });
    const tiny = laneBarRect('velocity', 1, 100);
    expect(tiny.h).toBe(2);
    expect(tiny.y).toBe(98);
    const mid = laneBarRect('velocity', 64, 100);
    expect(mid.h).toBeCloseTo((64 / 127) * 98, 9);
  });

  it('grows bipolar bars up from the center for positive values', () => {
    const rect = laneBarRect('offset', 0.5, 100);
    expect(rect.y).toBeCloseTo(1, 9);
    expect(rect.h).toBeCloseTo(49, 9);
  });

  it('grows bipolar bars down from the center for negative values', () => {
    const rect = laneBarRect('offset', -0.5, 100);
    expect(rect.y).toBe(50);
    expect(rect.h).toBeCloseTo(49, 9);
  });

  it('renders a minimal center tick at zero', () => {
    const rect = laneBarRect('offset', 0, 100);
    expect(rect.h).toBe(2);
    expect(rect.y).toBe(48);
  });
});

describe('laneUpdateForValue', () => {
  it('builds velocity updates and skips unchanged values', () => {
    const note = makeNote({ id: 7, velocity: 96 });
    expect(laneUpdateForValue('velocity', note, 100)).toEqual({ id: 7, velocity: 100 });
    expect(laneUpdateForValue('velocity', note, 96)).toBeNull();
  });

  it('builds length updates against durationPpq', () => {
    const note = makeNote({ id: 7, durationPpq: 1 });
    expect(laneUpdateForValue('length', note, 2)).toEqual({ id: 7, durationPpq: 2 });
    expect(laneUpdateForValue('length', note, 1)).toBeNull();
    // Values clamp into the lane range before comparing.
    expect(laneUpdateForValue('length', note, 100)).toEqual({ id: 7, durationPpq: 16 });
  });

  it('rewrites the note start relative to the nearest sixteenth for offset', () => {
    const note = makeNote({ id: 7, startPpq: 4.125 });
    expect(laneUpdateForValue('offset', note, 0.25)).toEqual({ id: 7, startPpq: 4.5 });
    expect(laneUpdateForValue('offset', note, -0.125)).toBeNull();
  });

  it('clamps offset targets at the timeline origin', () => {
    const note = makeNote({ id: 7, startPpq: 0.25 });
    expect(laneUpdateForValue('offset', note, -0.5)).toEqual({ id: 7, startPpq: 0 });
    const atZero = makeNote({ id: 8, startPpq: 0 });
    expect(laneUpdateForValue('offset', atZero, -0.5)).toBeNull();
  });

  it('keeps offset edits inside the audible source window', () => {
    const note = makeNote({ id: 7, startPpq: 1.1, durationPpq: 0.5 });
    expect(laneUpdateForValue('offset', note, 0.5, { minStartPpq: 1, maxEndPpq: 1.5 })).toEqual({
      id: 7,
      startPpq: 1,
    });
  });

  it('treats the default off-velocity as unchanged on notes without the field', () => {
    const note = makeNote({ id: 7 });
    expect(laneUpdateForValue('offVelocity', note, DEFAULT_OFF_VELOCITY)).toBeNull();
    expect(laneUpdateForValue('offVelocity', note, 80)).toEqual({ id: 7, offVelocity: 80 });
  });

  it('builds stepped channel updates', () => {
    const note = makeNote({ id: 7, channel: 0 });
    expect(laneUpdateForValue('channel', note, 9.4)).toEqual({ id: 7, channel: 9 });
    expect(laneUpdateForValue('channel', note, 0.2)).toBeNull();
  });
});

describe('formatLaneValue', () => {
  it('formats velocities as plain integers', () => {
    expect(formatLaneValue('velocity', 100)).toBe('100');
    expect(formatLaneValue('offVelocity', 64)).toBe('64');
  });

  it('formats channels as the 1-based display number', () => {
    expect(formatLaneValue('channel', 0)).toBe('1');
    expect(formatLaneValue('channel', 15)).toBe('16');
  });

  it('formats lengths in beats with trimmed decimals', () => {
    expect(formatLaneValue('length', 1.5)).toBe('1.5 beats');
    expect(formatLaneValue('length', 0.0625)).toBe('0.063 beats');
    expect(formatLaneValue('length', 16)).toBe('16 beats');
  });

  it('formats offsets with an explicit sign', () => {
    expect(formatLaneValue('offset', 0.125)).toBe('+0.125 beats');
    expect(formatLaneValue('offset', -0.25)).toBe('-0.25 beats');
    expect(formatLaneValue('offset', 0)).toBe('0 beats');
  });
});

describe('rampValueAt', () => {
  it('interpolates linearly between the anchors', () => {
    expect(rampValueAt(0, 10, 100, 110, 50)).toBe(60);
    expect(rampValueAt(0, 10, 100, 110, 0)).toBe(10);
    expect(rampValueAt(0, 10, 100, 110, 100)).toBe(110);
  });

  it('clamps positions outside the segment to the endpoint values', () => {
    expect(rampValueAt(0, 10, 100, 110, -50)).toBe(10);
    expect(rampValueAt(0, 10, 100, 110, 150)).toBe(110);
  });

  it('handles right-to-left segments', () => {
    expect(rampValueAt(100, 110, 0, 10, 50)).toBe(60);
    expect(rampValueAt(100, 110, 0, 10, 150)).toBe(110);
  });

  it('returns the end value for a zero-width segment', () => {
    expect(rampValueAt(50, 10, 50, 99, 50)).toBe(99);
  });
});

describe('barsInSpan', () => {
  const bars = [makeBar(1, 0), makeBar(2, 20), makeBar(3, 40), makeBar(4, 60)];

  it('buckets the bars whose columns overlap the swept span', () => {
    expect(barsInSpan(bars, 18, 45).map((bar) => bar.id)).toEqual([2, 3]);
  });

  it('includes bars touching an endpoint', () => {
    // Bar 1 covers x [0, 6]; a span starting exactly at 6 still touches it.
    expect(barsInSpan(bars, 6, 22).map((bar) => bar.id)).toEqual([1, 2]);
  });

  it('accepts endpoints in either order', () => {
    expect(barsInSpan(bars, 45, 18).map((bar) => bar.id)).toEqual([2, 3]);
  });

  it('returns an empty bucket for a span between bars', () => {
    expect(barsInSpan(bars, 8, 18)).toEqual([]);
  });

  it('handles a zero-width span inside one bar', () => {
    expect(barsInSpan(bars, 42, 42).map((bar) => bar.id)).toEqual([3]);
  });
});
