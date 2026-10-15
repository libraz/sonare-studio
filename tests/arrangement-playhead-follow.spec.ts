import { describe, expect, it } from 'vitest';
import {
  anchoredPlayheadFollowStart,
  nextHorizontalFollowScrollLeft,
  revealPlayheadStart,
} from '@/ui/arrangement/playhead-follow';
import { TimelineRange } from '@/ui/canvas/timeline-range';

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

describe('anchoredPlayheadFollowStart', () => {
  it('pins the playhead to the anchor column', () => {
    const range = new TimelineRange({ widthPx: 1000, heightPx: 400, pxPerPpq: 100 });

    // anchor 250px at 100px/quarter => playhead 4 sits at start 4 - 2.5 = 1.5.
    expect(anchoredPlayheadFollowStart(range, 4, 250)).toBeCloseTo(1.5, 9);
  });

  it('clamps the anchored start at the timeline origin', () => {
    const range = new TimelineRange({
      widthPx: 1000,
      heightPx: 400,
      pxPerPpq: 100,
      startPpq: 5,
    });

    expect(anchoredPlayheadFollowStart(range, 1, 250)).toBe(0);
  });

  it('returns null when the viewport is already anchored', () => {
    const range = new TimelineRange({
      widthPx: 1000,
      heightPx: 400,
      pxPerPpq: 100,
      startPpq: 1.5,
    });

    expect(anchoredPlayheadFollowStart(range, 4, 250)).toBeNull();
  });
});

describe('revealPlayheadStart', () => {
  it('leaves the viewport alone while the playhead is already visible', () => {
    const range = new TimelineRange({ widthPx: 1000, heightPx: 400, pxPerPpq: 100 });

    expect(revealPlayheadStart(range, 5, 250)).toBeNull();
  });

  it('scrolls an off-screen playhead to the anchor column', () => {
    const range = new TimelineRange({ widthPx: 1000, heightPx: 400, pxPerPpq: 100 });

    // Playhead at 40 quarters is far past the right edge; reveal to anchor 250px.
    expect(revealPlayheadStart(range, 40, 250)).toBeCloseTo(37.5, 9);
  });

  it('scrolls back when the playhead sits left of the viewport', () => {
    const range = new TimelineRange({
      widthPx: 1000,
      heightPx: 400,
      pxPerPpq: 100,
      startPpq: 30,
    });

    expect(revealPlayheadStart(range, 2, 250)).toBe(0);
  });
});
