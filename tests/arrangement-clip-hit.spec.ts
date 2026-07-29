import { describe, expect, it } from 'vitest';
import {
  type ArrangeClipRect,
  type ClipLaneView,
  DEFAULT_TRIM_TOLERANCE_PX,
  hitTestClip,
} from '@/ui/arrangement/clip-hit';

/** Linear view: 10 px per PPQ, 50 px lanes, no scroll or ruler offset. */
const view: ClipLaneView = {
  ppqToX: (ppq) => ppq * 10,
  xToPpq: (x) => x / 10,
  laneTop: (index) => index * 50,
  laneIndexAtY: (y) => Math.floor(y / 50),
  laneHeight: 50,
};

const clip = (
  id: number,
  laneIndex: number,
  startPpq: number,
  lengthPpq: number,
): ArrangeClipRect => ({ id, laneIndex, startPpq, lengthPpq });

// Clip 1: x [40, 120), lane 0 -> y [0, 50).
const clips: ArrangeClipRect[] = [clip(1, 0, 4, 8), clip(2, 1, 0, 4)];

describe('hitTestClip', () => {
  it('hits the clip body in the middle of the rect', () => {
    expect(hitTestClip(clips, { x: 80, y: 25 }, view)).toEqual({ id: 1, zone: 'body' });
  });

  it('hits clips per lane', () => {
    expect(hitTestClip(clips, { x: 20, y: 75 }, view)).toEqual({ id: 2, zone: 'body' });
    expect(hitTestClip(clips, { x: 20, y: 25 }, view)).toBeNull();
  });

  it('returns null outside any clip', () => {
    expect(hitTestClip(clips, { x: 130, y: 25 }, view)).toBeNull(); // past the end
    expect(hitTestClip(clips, { x: 80, y: 125 }, view)).toBeNull(); // empty lane
    expect(hitTestClip(clips, { x: 39, y: 25 }, view)).toBeNull(); // before the start
  });

  it('resolves trim zones within the default tolerance', () => {
    expect(hitTestClip(clips, { x: 40, y: 25 }, view)?.zone).toBe('trim-start');
    expect(hitTestClip(clips, { x: 40 + DEFAULT_TRIM_TOLERANCE_PX, y: 25 }, view)?.zone).toBe(
      'trim-start',
    );
    expect(
      hitTestClip(clips, { x: 40 + DEFAULT_TRIM_TOLERANCE_PX + 0.01, y: 25 }, view)?.zone,
    ).toBe('body');
    expect(hitTestClip(clips, { x: 119, y: 25 }, view)?.zone).toBe('trim-end');
  });

  it('respects a custom trim tolerance', () => {
    const opts = { trimTolerancePx: 12 };
    expect(hitTestClip(clips, { x: 52, y: 25 }, view, opts)?.zone).toBe('trim-start');
    expect(hitTestClip(clips, { x: 53, y: 25 }, view, opts)?.zone).toBe('body');
    expect(hitTestClip(clips, { x: 108, y: 25 }, view, opts)?.zone).toBe('trim-end');
  });

  it('keeps a body zone on a narrow clip while both trim handles stay reachable', () => {
    const narrow = [clip(3, 0, 0, 0.8)]; // 8 px wide, below 2 * tolerance
    expect(hitTestClip(narrow, { x: 1, y: 25 }, view)?.zone).toBe('trim-start');
    expect(hitTestClip(narrow, { x: 3, y: 25 }, view)?.zone).toBe('body');
    expect(hitTestClip(narrow, { x: 7, y: 25 }, view)?.zone).toBe('trim-end');
  });

  it('prefers the topmost (last drawn) clip when clips overlap', () => {
    const overlapping = [clip(1, 0, 0, 8), clip(2, 0, 4, 8)];
    expect(hitTestClip(overlapping, { x: 60, y: 25 }, view)?.id).toBe(2);
  });

  it('treats the left edge as inclusive and the right edge as exclusive', () => {
    expect(hitTestClip(clips, { x: 40, y: 25 }, view)).not.toBeNull();
    expect(hitTestClip(clips, { x: 120, y: 25 }, view)).toBeNull();
    expect(hitTestClip(clips, { x: 80, y: 0 }, view)).not.toBeNull();
    expect(hitTestClip(clips, { x: 80, y: 50 }, view)).toBeNull();
  });
});
