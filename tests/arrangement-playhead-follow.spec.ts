import { describe, expect, it } from 'vitest';
import { nextPlayheadFollowStart } from '@/ui/arrangement/playhead-follow';
import { TimelineRange } from '@/ui/canvas/timeline-range';

describe('nextPlayheadFollowStart', () => {
  it('does not scroll while the playhead is inside the follow window', () => {
    const range = new TimelineRange({ widthPx: 1000, heightPx: 400, pxPerPpq: 100 });

    expect(nextPlayheadFollowStart(range, 5)).toBeNull();
  });

  it('advances the viewport when playback crosses the right follow boundary', () => {
    const range = new TimelineRange({ widthPx: 1000, heightPx: 400, pxPerPpq: 100 });

    expect(nextPlayheadFollowStart(range, 9)).toBeCloseTo(0.8, 9);
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
