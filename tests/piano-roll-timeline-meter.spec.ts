import { describe, expect, it } from 'vitest';
import { pianoRollStatusLocation } from '@/components/piano-roll/status-location';
import {
  floorLocalPpqToMeterGrid,
  localMeasureRange,
  localRulerTicks,
  snapLocalPpqToMeterGrid,
} from '@/components/piano-roll/timeline-meter';
import { snapPpqToMeterGrid } from '@/project/time-signature';
import type { TimeSignatureSegment } from '@/project/types';
import { rulerTicks } from '@/ui/arrangement/ruler';

const FOUR_FOUR: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 4, denominator: 4 }];
/** A clip origin one beat before the bar line at timeline 8 -> a mid-bar origin. */
const ORIGIN = 6;

describe('piano-roll bar math on a mid-bar clip origin', () => {
  it('places bar lines at the timeline bars, not at the clip origin', () => {
    const bars = localRulerTicks(FOUR_FOUR, ORIGIN, 0, 10, 10).filter(
      (tick) => tick.kind === 'bar',
    );
    expect(bars.map((tick) => tick.ppq)).toEqual([2, 6]);
  });

  it('numbers bars like the timeline ruler', () => {
    const local = localRulerTicks(FOUR_FOUR, ORIGIN, 0, 10, 10).filter(
      (tick) => tick.kind === 'bar',
    );
    const timeline = rulerTicks(FOUR_FOUR, ORIGIN, ORIGIN + 10, 10).filter(
      (tick) => tick.kind === 'bar',
    );
    expect(local.map((tick) => tick.barNumber)).toEqual(timeline.map((tick) => tick.barNumber));
    expect(local.map((tick) => tick.barNumber)).toEqual([3, 4]);
  });

  it('snaps in Bar mode to the timeline bar lines and agrees with the timeline snap', () => {
    for (const local of [0.4, 2.9, 3.9, 5.5, 7.9]) {
      const snapped = snapLocalPpqToMeterGrid(FOUR_FOUR, ORIGIN, local, 'bar');
      expect(snapped + ORIGIN).toBe(snapPpqToMeterGrid(FOUR_FOUR, local + ORIGIN, 'bar'));
      expect((snapped + ORIGIN) % 4).toBe(0);
    }
  });

  it('snaps grid steps to the timeline grid', () => {
    expect(snapLocalPpqToMeterGrid(FOUR_FOUR, 6.1, 1.95, 0.25)).toBeCloseTo(1.9, 9);
  });

  it('resolves the bar containing a local position', () => {
    const bar = localMeasureRange(FOUR_FOUR, ORIGIN, 3);
    expect(bar.startPpq).toBe(2);
    expect(bar.lengthPpq).toBe(4);
    expect(bar.index).toBe(2);
  });

  it('reports the bar and beat of a hovered local position on the timeline', () => {
    expect(pianoRollStatusLocation(FOUR_FOUR, 1 + ORIGIN)).toEqual({ bar: 2, beat: 4 });
    expect(pianoRollStatusLocation(FOUR_FOUR, 2 + ORIGIN)).toEqual({ bar: 3, beat: 1 });
  });

  it('floors to the cell or bar containing the position', () => {
    expect(floorLocalPpqToMeterGrid(FOUR_FOUR, 0, 1.9, 0.25)).toBe(1.75);
    expect(floorLocalPpqToMeterGrid(FOUR_FOUR, 0, 1.75, 0.25)).toBe(1.75);
    expect(floorLocalPpqToMeterGrid(FOUR_FOUR, 0, 3.9, 'bar')).toBe(0);
    expect(floorLocalPpqToMeterGrid(FOUR_FOUR, 0, 5.9, 'bar')).toBe(4);
    expect(floorLocalPpqToMeterGrid(FOUR_FOUR, ORIGIN, 3.9, 'bar')).toBe(2);
  });
});
