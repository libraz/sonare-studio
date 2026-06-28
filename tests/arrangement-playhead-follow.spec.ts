import { describe, expect, it } from 'vitest';
import {
  nextHorizontalFollowScrollLeft,
  nextPlayheadFollowStart,
} from '@/ui/arrangement/playhead-follow';
import { TimelineRange } from '@/ui/canvas/timeline-range';

describe('nextPlayheadFollowStart', () => {
  it('does not scroll while the playhead is inside the follow window', () => {
    const range = new TimelineRange({ widthPx: 1000, heightPx: 400, pxPerPpq: 100 });

    expect(nextPlayheadFollowStart(range, 6)).toBeNull();
  });

  it('advances the viewport when playback crosses the right follow boundary', () => {
    const range = new TimelineRange({ widthPx: 1000, heightPx: 400, pxPerPpq: 100 });

    expect(nextPlayheadFollowStart(range, 9)).toBeCloseTo(2.2, 9);
  });

  it('moves back for loop wrap or backward seek past the left follow boundary', () => {
    const range = new TimelineRange({
      widthPx: 1000,
      heightPx: 400,
      pxPerPpq: 100,
      startPpq: 8,
    });

    expect(nextPlayheadFollowStart(range, 8.5)).toBeCloseTo(7.3, 9);
  });

  it('clamps the followed start at the timeline origin', () => {
    const range = new TimelineRange({
      widthPx: 1000,
      heightPx: 400,
      pxPerPpq: 100,
      startPpq: 1,
    });

    expect(nextPlayheadFollowStart(range, 0.5)).toBe(0);
  });
});

describe('nextHorizontalFollowScrollLeft', () => {
  it('does not scroll while the item is inside the follow window', () => {
    expect(nextHorizontalFollowScrollLeft(1000, 200, 450, 480)).toBeNull();
  });

  it('scrolls right when the item crosses the right boundary', () => {
    expect(nextHorizontalFollowScrollLeft(1000, 0, 900, 940)).toBeCloseTo(260, 9);
  });

  it('scrolls left when the item crosses the left boundary', () => {
    expect(nextHorizontalFollowScrollLeft(1000, 500, 560, 590)).toBeCloseTo(440, 9);
  });

  it('clamps leftward scrolling at the origin', () => {
    expect(nextHorizontalFollowScrollLeft(1000, 50, 20, 40)).toBe(0);
  });
});
