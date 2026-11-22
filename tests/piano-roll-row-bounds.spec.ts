import { describe, expect, it } from 'vitest';
import { TimelineRange } from '@/ui/canvas/timeline-range';
import { centerRangeOnPitch } from '@/ui/piano-roll/use-piano-roll-viewport';
import { MAX_ROW_HEIGHT, MIN_ROW_HEIGHT } from '@/ui/piano-roll/use-piano-roll-zoom';

describe('piano-roll row bounds and centering', () => {
  it('exports the shared row-height bounds', () => {
    expect([MIN_ROW_HEIGHT, MAX_ROW_HEIGHT]).toEqual([5, 40]);
  });

  it('centers a pitch row in the viewport', () => {
    const range = new TimelineRange({ widthPx: 400, heightPx: 300, pxPerPpq: 50, rowHeight: 10 });
    centerRangeOnPitch(range, 60);
    expect(range.pitchToY(60) + range.rowHeight / 2).toBeCloseTo(range.heightPx / 2, 9);
  });

  it('centers from a non-zero scroll position', () => {
    const range = new TimelineRange({ widthPx: 400, heightPx: 300, pxPerPpq: 50, rowHeight: 10 });
    range.setScrollY(200);
    centerRangeOnPitch(range, 72);
    expect(range.pitchToY(72) + range.rowHeight / 2).toBeCloseTo(range.heightPx / 2, 9);
  });
});
