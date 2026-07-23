import { describe, expect, it } from 'vitest';
import {
  gridStepPpq,
  MAX_PITCH,
  MIN_PITCH,
  PITCH_ROW_COUNT,
  type SnapDivision,
  snapPpq,
  snapPpqToStep,
  TimelineRange,
} from '@/ui/canvas/timeline-range';

const div = (
  denominator: SnapDivision['denominator'],
  modifier: SnapDivision['modifier'] = 'straight',
): SnapDivision => ({ denominator, modifier });

describe('gridStepPpq', () => {
  it('maps straight divisions to whole-note fractions (quarter = 1 PPQ)', () => {
    expect(gridStepPpq(div(1))).toBe(4);
    expect(gridStepPpq(div(2))).toBe(2);
    expect(gridStepPpq(div(4))).toBe(1);
    expect(gridStepPpq(div(8))).toBe(0.5);
    expect(gridStepPpq(div(16))).toBe(0.25);
    expect(gridStepPpq(div(32))).toBe(0.125);
    expect(gridStepPpq(div(64))).toBe(0.0625);
  });

  it('scales triplets to 2/3 of the straight step', () => {
    expect(gridStepPpq(div(4, 'triplet'))).toBeCloseTo(2 / 3, 12);
    expect(gridStepPpq(div(8, 'triplet'))).toBeCloseTo(1 / 3, 12);
    expect(gridStepPpq(div(16, 'triplet'))).toBeCloseTo(1 / 6, 12);
  });

  it('scales dotted to 1.5x the straight step', () => {
    expect(gridStepPpq(div(4, 'dotted'))).toBe(1.5);
    expect(gridStepPpq(div(8, 'dotted'))).toBe(0.75);
    expect(gridStepPpq(div(64, 'dotted'))).toBeCloseTo(0.09375, 12);
  });
});

describe('snapPpq', () => {
  it('snaps to the nearest straight grid line', () => {
    expect(snapPpq(1.2, div(4))).toBe(1);
    expect(snapPpq(1.6, div(4))).toBe(2);
    expect(snapPpq(0.13, div(16))).toBe(0.25);
    expect(snapPpq(0.12, div(16))).toBe(0);
    expect(snapPpq(3.9, div(1))).toBe(4);
  });

  it('rounds midpoints up', () => {
    expect(snapPpq(0.5, div(4))).toBe(1);
    expect(snapPpq(0.125, div(16))).toBe(0.25);
  });

  it('snaps triplet grids', () => {
    const eighthTriplet = div(8, 'triplet');
    expect(snapPpq(0.3, eighthTriplet)).toBeCloseTo(1 / 3, 12);
    expect(snapPpq(0.7, eighthTriplet)).toBeCloseTo(2 / 3, 12);
    expect(snapPpq(0.95, eighthTriplet)).toBeCloseTo(1, 12);
  });

  it('snaps dotted grids', () => {
    const dottedEighth = div(8, 'dotted');
    expect(snapPpq(0.7, dottedEighth)).toBe(0.75);
    expect(snapPpq(1.6, dottedEighth)).toBe(1.5);
    expect(snapPpq(1.9, dottedEighth)).toBe(2.25);
  });

  it('leaves on-grid positions unchanged', () => {
    expect(snapPpq(2, div(4))).toBe(2);
    expect(snapPpq(0.75, div(8, 'dotted'))).toBe(0.75);
  });

  it('never returns a negative position', () => {
    expect(snapPpq(-0.4, div(4))).toBe(0);
    expect(snapPpq(-100, div(16, 'triplet'))).toBe(0);
  });

  it('shares numeric-step snapping with arrangement and piano-roll gestures', () => {
    expect(snapPpqToStep(1.13, 0.25)).toBe(1.25);
    expect(snapPpqToStep(-0.2, 0.25)).toBe(0);
    expect(snapPpqToStep(-0.2, 0)).toBe(0);
  });
});

describe('TimelineRange horizontal mapping', () => {
  it('exposes the visible range [startPpq, endPpq)', () => {
    const range = new TimelineRange({ widthPx: 800, heightPx: 400, pxPerPpq: 100 });
    expect(range.startPpq).toBe(0);
    expect(range.endPpq).toBe(8);
  });

  it('maps ppqToX and back (round trip) at various zoom/scroll states', () => {
    const range = new TimelineRange({ widthPx: 640, heightPx: 480, pxPerPpq: 37.5, startPpq: 12 });
    for (const ppq of [0, 3.25, 12, 19.7, 100]) {
      expect(range.xToPpq(range.ppqToX(ppq))).toBeCloseTo(ppq, 9);
    }
    for (const x of [-50, 0, 1, 320, 639.5]) {
      expect(range.ppqToX(range.xToPpq(x))).toBeCloseTo(x, 9);
    }
  });

  it('maps startPpq to x = 0 and scales by pxPerPpq', () => {
    const range = new TimelineRange({ widthPx: 800, heightPx: 400, pxPerPpq: 50, startPpq: 4 });
    expect(range.ppqToX(4)).toBe(0);
    expect(range.ppqToX(6)).toBe(100);
    expect(range.xToPpq(200)).toBe(8);
  });

  it('scrolls by ppq and px equivalently', () => {
    const a = new TimelineRange({ widthPx: 800, heightPx: 400, pxPerPpq: 50, startPpq: 10 });
    const b = new TimelineRange({ widthPx: 800, heightPx: 400, pxPerPpq: 50, startPpq: 10 });
    a.scrollByPpq(2.5);
    b.scrollByPx(125);
    expect(a.startPpq).toBe(12.5);
    expect(b.startPpq).toBe(12.5);
  });

  it('clamps horizontal scroll at ppq 0', () => {
    const range = new TimelineRange({ widthPx: 800, heightPx: 400, pxPerPpq: 100, startPpq: 1 });
    range.scrollByPpq(-5);
    expect(range.startPpq).toBe(0);
    range.scrollByPx(-100);
    expect(range.startPpq).toBe(0);
    range.setStartPpq(-3);
    expect(range.startPpq).toBe(0);
  });
});

describe('TimelineRange zoom around anchor', () => {
  it('keeps the ppq under the anchor x fixed when zooming in', () => {
    const range = new TimelineRange({ widthPx: 800, heightPx: 400, pxPerPpq: 100, startPpq: 4 });
    const anchorX = 300;
    const anchorPpq = range.xToPpq(anchorX);
    range.zoomAt(anchorX, 2);
    expect(range.pxPerPpq).toBe(200);
    expect(range.xToPpq(anchorX)).toBeCloseTo(anchorPpq, 9);
    expect(range.ppqToX(anchorPpq)).toBeCloseTo(anchorX, 9);
  });

  it('keeps the anchor fixed when zooming out (when no clamp applies)', () => {
    const range = new TimelineRange({ widthPx: 800, heightPx: 400, pxPerPpq: 200, startPpq: 20 });
    const anchorX = 650;
    const anchorPpq = range.xToPpq(anchorX);
    range.zoomAt(anchorX, 0.5);
    expect(range.pxPerPpq).toBe(100);
    expect(range.ppqToX(anchorPpq)).toBeCloseTo(anchorX, 9);
  });

  it('keeps the anchor fixed across a sequence of zooms', () => {
    const range = new TimelineRange({ widthPx: 1000, heightPx: 400, pxPerPpq: 80, startPpq: 16 });
    const anchorX = 480;
    const anchorPpq = range.xToPpq(anchorX);
    for (const factor of [1.25, 1.25, 0.8, 2, 0.5, 1.1]) {
      range.zoomAt(anchorX, factor);
      expect(range.ppqToX(anchorPpq)).toBeCloseTo(anchorX, 6);
    }
  });

  it('clamps pxPerPpq to the configured bounds', () => {
    const range = new TimelineRange({
      widthPx: 800,
      heightPx: 400,
      pxPerPpq: 100,
      minPxPerPpq: 10,
      maxPxPerPpq: 400,
    });
    range.zoomAt(0, 1000);
    expect(range.pxPerPpq).toBe(400);
    range.zoomAt(0, 0.000001);
    expect(range.pxPerPpq).toBe(10);
  });

  it('clamps startPpq to >= 0 when zooming out near the origin', () => {
    const range = new TimelineRange({ widthPx: 800, heightPx: 400, pxPerPpq: 100, startPpq: 0.5 });
    range.zoomAt(400, 0.25);
    expect(range.startPpq).toBe(0);
  });

  it('ignores non-positive or non-finite zoom factors', () => {
    const range = new TimelineRange({ widthPx: 800, heightPx: 400, pxPerPpq: 100, startPpq: 2 });
    range.zoomAt(100, 0);
    range.zoomAt(100, -2);
    range.zoomAt(100, Number.NaN);
    expect(range.pxPerPpq).toBe(100);
    expect(range.startPpq).toBe(2);
  });
});

describe('TimelineRange vertical mapping', () => {
  it('puts pitch 127 at the top row', () => {
    const range = new TimelineRange({ widthPx: 800, heightPx: 400, rowHeight: 10 });
    expect(range.pitchToY(MAX_PITCH)).toBe(0);
    expect(range.pitchToY(126)).toBe(10);
    expect(range.pitchToY(MIN_PITCH)).toBe(127 * 10);
  });

  it('round-trips pitch through the center of each row', () => {
    const range = new TimelineRange({ widthPx: 800, heightPx: 400, rowHeight: 12 });
    for (let pitch = MIN_PITCH; pitch <= MAX_PITCH; pitch++) {
      expect(range.yToPitch(range.pitchToY(pitch) + 6)).toBe(pitch);
    }
  });

  it('treats the row top as inclusive and the row bottom as the next pitch', () => {
    const range = new TimelineRange({ widthPx: 800, heightPx: 400, rowHeight: 10 });
    expect(range.yToPitch(0)).toBe(127);
    expect(range.yToPitch(9.999)).toBe(127);
    expect(range.yToPitch(10)).toBe(126);
  });

  it('clamps yToPitch to the MIDI range', () => {
    const range = new TimelineRange({ widthPx: 800, heightPx: 400, rowHeight: 10 });
    expect(range.yToPitch(-50)).toBe(MAX_PITCH);
    range.setScrollY(Number.MAX_SAFE_INTEGER);
    expect(range.yToPitch(range.heightPx + 10000)).toBe(MIN_PITCH);
  });

  it('offsets the mapping by scrollY', () => {
    const range = new TimelineRange({ widthPx: 800, heightPx: 400, rowHeight: 10 });
    range.setScrollY(100);
    expect(range.pitchToY(MAX_PITCH)).toBe(-100);
    expect(range.yToPitch(0)).toBe(117);
  });

  it('clamps scrollY to the scrollable content extent', () => {
    const rowHeight = 10;
    const heightPx = 400;
    const range = new TimelineRange({ widthPx: 800, heightPx, rowHeight });
    const maxScroll = PITCH_ROW_COUNT * rowHeight - heightPx;
    range.scrollByY(-50);
    expect(range.scrollY).toBe(0);
    range.scrollByY(1e9);
    expect(range.scrollY).toBe(maxScroll);
    range.setScrollY(maxScroll + 1);
    expect(range.scrollY).toBe(maxScroll);
  });

  it('re-clamps scrollY on resize and row height changes', () => {
    const range = new TimelineRange({ widthPx: 800, heightPx: 400, rowHeight: 10 });
    range.setScrollY(880); // max for height 400
    range.resize(800, 1000);
    expect(range.scrollY).toBe(PITCH_ROW_COUNT * 10 - 1000);
    range.setRowHeight(8);
    expect(range.scrollY).toBe(PITCH_ROW_COUNT * 8 - 1000);
  });

  it('updates endPpq when the viewport is resized', () => {
    const range = new TimelineRange({ widthPx: 800, heightPx: 400, pxPerPpq: 100 });
    range.resize(400, 400);
    expect(range.endPpq).toBe(4);
  });
});
