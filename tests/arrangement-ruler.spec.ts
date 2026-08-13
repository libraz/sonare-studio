import { describe, expect, it, vi } from 'vitest';
import {
  barRangeAt,
  createRulerTickCache,
  DEFAULT_MIN_BAR_SPACING_PX,
  localizeMeter,
  type MeterSegment,
  nearestBarPpq,
  type RulerTick,
  rulerTicks,
} from '@/ui/arrangement/ruler';

const FOUR_FOUR: MeterSegment[] = [{ startPpq: 0, numerator: 4, denominator: 4 }];

function bars(ticks: RulerTick[]): RulerTick[] {
  return ticks.filter((tick) => tick.kind === 'bar');
}

function beats(ticks: RulerTick[]): RulerTick[] {
  return ticks.filter((tick) => tick.kind === 'beat');
}

describe('rulerTicks', () => {
  it('assumes 4/4 when the meter map is empty', () => {
    const ticks = rulerTicks([], 0, 16, 50);
    expect(bars(ticks).map((t) => t.ppq)).toEqual([0, 4, 8, 12]);
    expect(bars(ticks).map((t) => t.barNumber)).toEqual([1, 2, 3, 4]);
  });

  it('emits beats between bars when the zoom leaves room', () => {
    const ticks = rulerTicks(FOUR_FOUR, 0, 8, 50);
    expect(beats(ticks).map((t) => t.ppq)).toEqual([1, 2, 3, 5, 6, 7]);
  });

  it('suppresses beats below the minimum spacing', () => {
    // One beat = 1 PPQ = 4 px, below the 6 px default.
    const ticks = rulerTicks(FOUR_FOUR, 0, 64, 4);
    expect(beats(ticks)).toEqual([]);
    expect(bars(ticks).length).toBeGreaterThan(0);
  });

  it('caps extreme zoom-out bar ticks with a power-of-two stride', () => {
    const lowZoom = bars(rulerTicks(FOUR_FOUR, 0, 10_000, 0.01));
    const lessZoomedOut = bars(rulerTicks(FOUR_FOUR, 0, 10_000, 0.02));
    const visibleWidthPx = 10_000 * 0.01;

    expect(lowZoom.length).toBeLessThanOrEqual(
      Math.ceil(visibleWidthPx / DEFAULT_MIN_BAR_SPACING_PX) + 1,
    );
    expect(lowZoom.length).toBeLessThanOrEqual(lessZoomedOut.length);
  });

  it('keeps meter boundaries and global bar numbers when bars are strided', () => {
    const meter: MeterSegment[] = [
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 256, numerator: 3, denominator: 4 },
    ];
    const ticks = bars(rulerTicks(meter, 0, 4_000, 0.01, { minBarSpacingPx: 6 }));

    expect(ticks.map((tick) => tick.ppq)).toEqual([0, 256, 1024, 1792, 2560, 3328]);
    expect(ticks.map((tick) => tick.barNumber)).toEqual([1, 65, 321, 577, 833, 1089]);
  });

  it('labels every bar at high zoom and thins labels in powers of two', () => {
    const dense = rulerTicks(FOUR_FOUR, 0, 16, 50);
    expect(bars(dense).every((t) => t.label !== undefined)).toBe(true);

    // One bar = 16 px; labels need 44 px, so every 4th bar gets one.
    const sparse = rulerTicks(FOUR_FOUR, 0, 64, 4);
    const labeled = bars(sparse).filter((t) => t.label !== undefined);
    expect(labeled.map((t) => t.label)).toEqual(['1', '5', '9', '13']);
  });

  it('keeps bar numbering continuous across a meter change', () => {
    const meter: MeterSegment[] = [
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 16, numerator: 3, denominator: 4 },
    ];
    const ticks = bars(rulerTicks(meter, 0, 28, 50));
    expect(ticks.map((t) => t.ppq)).toEqual([0, 4, 8, 12, 16, 19, 22, 25]);
    expect(ticks.map((t) => t.barNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('starts a new bar at a mid-bar meter change', () => {
    const meter: MeterSegment[] = [
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 6, numerator: 4, denominator: 4 },
    ];
    const ticks = bars(rulerTicks(meter, 0, 16, 50));
    expect(ticks.map((t) => t.ppq)).toEqual([0, 4, 6, 10, 14]);
    // The truncated bar before the change still counts as one bar.
    expect(ticks.map((t) => t.barNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it('only emits ticks inside the visible range', () => {
    const ticks = rulerTicks(FOUR_FOUR, 7, 13, 50);
    expect(ticks.every((t) => t.ppq >= 7 && t.ppq < 13)).toBe(true);
    expect(bars(ticks).map((t) => t.ppq)).toEqual([8, 12]);
    expect(bars(ticks).map((t) => t.barNumber)).toEqual([3, 4]);
  });

  it('returns nothing for empty or inverted ranges and non-positive zoom', () => {
    expect(rulerTicks(FOUR_FOUR, 8, 8, 50)).toEqual([]);
    expect(rulerTicks(FOUR_FOUR, 8, 4, 50)).toEqual([]);
    expect(rulerTicks(FOUR_FOUR, 0, 8, 0)).toEqual([]);
  });

  it('can disable bar labels with a non-finite spacing without suppressing ticks', () => {
    const ticks = rulerTicks(FOUR_FOUR, 0, 8, 50, {
      minBeatSpacingPx: 6,
      minBarLabelSpacingPx: Number.POSITIVE_INFINITY,
    });
    expect(ticks.length).toBeGreaterThan(0);
    expect(bars(ticks).length).toBeGreaterThan(0);
    expect(ticks.every((tick) => tick.label === undefined)).toBe(true);
  });
});

describe('localizeMeter', () => {
  const mixed: MeterSegment[] = [
    { startPpq: 0, numerator: 4, denominator: 4 },
    { startPpq: 8, numerator: 3, denominator: 4 },
    { startPpq: 17, numerator: 5, denominator: 8 },
  ];

  it('starts with the meter active at the clip timeline origin', () => {
    expect(localizeMeter(mixed, 8)).toEqual([
      { startPpq: 0, numerator: 3, denominator: 4 },
      { startPpq: 9, numerator: 5, denominator: 8 },
    ]);
  });

  it('shifts future meter changes into the clip-local frame', () => {
    expect(localizeMeter(mixed, 6)).toEqual([
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 2, numerator: 3, denominator: 4 },
      { startPpq: 11, numerator: 5, denominator: 8 },
    ]);
  });
});

describe('barRangeAt', () => {
  it('returns the containing bar in a uniform meter', () => {
    expect(barRangeAt(FOUR_FOUR, 5)).toEqual({ startPpq: 4, lengthPpq: 4 });
    expect(barRangeAt(FOUR_FOUR, 4)).toEqual({ startPpq: 4, lengthPpq: 4 });
    expect(barRangeAt([], 0)).toEqual({ startPpq: 0, lengthPpq: 4 });
  });

  it('clamps negative positions to PPQ zero', () => {
    expect(barRangeAt(FOUR_FOUR, -3)).toEqual({ startPpq: 0, lengthPpq: 4 });
  });

  it('truncates the bar before a mid-bar meter change', () => {
    const meter: MeterSegment[] = [
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 6, numerator: 3, denominator: 4 },
    ];
    expect(barRangeAt(meter, 5)).toEqual({ startPpq: 4, lengthPpq: 2 });
    expect(barRangeAt(meter, 7)).toEqual({ startPpq: 6, lengthPpq: 3 });
  });
});

describe('nearestBarPpq', () => {
  it('snaps to the closer bar boundary', () => {
    expect(nearestBarPpq(FOUR_FOUR, 1.9)).toBe(0);
    expect(nearestBarPpq(FOUR_FOUR, 2.1)).toBe(4);
    expect(nearestBarPpq(FOUR_FOUR, 4)).toBe(4);
  });

  it('respects truncated bars at meter changes', () => {
    const meter: MeterSegment[] = [
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 6, numerator: 3, denominator: 4 },
    ];
    // The bar [4, 6) is truncated; 5.5 is closer to 6 than to 4.
    expect(nearestBarPpq(meter, 5.5)).toBe(6);
  });
});

describe('createRulerTickCache', () => {
  it('computes once for repeated calls with identical arguments (cache hits)', () => {
    const compute = vi.fn(rulerTicks);
    const cached = createRulerTickCache(compute);

    const first = cached(FOUR_FOUR, 0, 16, 50);
    const second = cached(FOUR_FOUR, 0, 16, 50);
    const third = cached(FOUR_FOUR, 0, 16, 50);

    expect(compute).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first).toEqual(rulerTicks(FOUR_FOUR, 0, 16, 50));
  });

  it('recomputes when the view changes', () => {
    const compute = vi.fn(rulerTicks);
    const cached = createRulerTickCache(compute);

    cached(FOUR_FOUR, 0, 16, 50);
    cached(FOUR_FOUR, 4, 20, 50);
    cached(FOUR_FOUR, 4, 20, 25);

    expect(compute).toHaveBeenCalledTimes(3);
  });

  it('recomputes when the meter array identity changes', () => {
    const compute = vi.fn(rulerTicks);
    const cached = createRulerTickCache(compute);
    const otherMeter: MeterSegment[] = [{ startPpq: 0, numerator: 3, denominator: 4 }];

    cached(FOUR_FOUR, 0, 16, 50);
    const ticks = cached(otherMeter, 0, 16, 50);

    expect(compute).toHaveBeenCalledTimes(2);
    expect(ticks).toEqual(rulerTicks(otherMeter, 0, 16, 50));
  });
});
