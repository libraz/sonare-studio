import { describe, expect, it } from 'vitest';
import {
  beginSelection,
  clampFrameIndex,
  dragSelection,
  extendSelection,
  formatFrameCount,
  formatSeconds,
  selectionRange,
  selectionReadout,
} from '@/ui/sample-editor/selection';
import { MIN_FRAMES_PER_PX, SampleViewport } from '@/ui/sample-editor/viewport';

describe('selection model', () => {
  it('clampFrameIndex rounds and clamps into [0, totalFrames]', () => {
    expect(clampFrameIndex(4.4, 10)).toBe(4);
    expect(clampFrameIndex(4.6, 10)).toBe(5);
    expect(clampFrameIndex(-3, 10)).toBe(0);
    expect(clampFrameIndex(99, 10)).toBe(10);
    expect(clampFrameIndex(Number.NaN, 10)).toBe(0);
  });

  it('beginSelection starts an empty draft at the clamped frame', () => {
    expect(beginSelection(3.2, 10)).toEqual({ anchorFrame: 3, headFrame: 3 });
    expect(beginSelection(-1, 10)).toEqual({ anchorFrame: 0, headFrame: 0 });
  });

  it('dragSelection moves only the head', () => {
    const draft = beginSelection(2, 10);
    expect(dragSelection(draft, 7, 10)).toEqual({ anchorFrame: 2, headFrame: 7 });
    expect(dragSelection(draft, -5, 10)).toEqual({ anchorFrame: 2, headFrame: 0 });
  });

  it('extendSelection keeps the anchor (shift-click) or starts fresh', () => {
    const draft = { anchorFrame: 2, headFrame: 5 };
    expect(extendSelection(draft, 9, 10)).toEqual({ anchorFrame: 2, headFrame: 9 });
    expect(extendSelection(null, 4, 10)).toEqual({ anchorFrame: 4, headFrame: 4 });
  });

  it('selectionRange orders the bounds and nulls empty drafts', () => {
    expect(selectionRange({ anchorFrame: 8, headFrame: 3 })).toEqual({
      startFrame: 3,
      endFrame: 8,
    });
    expect(selectionRange({ anchorFrame: 3, headFrame: 3 })).toBeNull();
    expect(selectionRange(null)).toBeNull();
  });
});

describe('readout formatting', () => {
  it('formats frame counts and seconds', () => {
    expect(formatFrameCount(44100)).toBe('44,100');
    expect(formatSeconds(44100, 44100)).toBe('1.000 s');
    expect(formatSeconds(11025, 44100)).toBe('0.250 s');
    expect(formatSeconds(5, 0)).toBe('0.000 s');
  });

  it('selectionReadout shows the file extent without a selection', () => {
    expect(selectionReadout(null, 48000, 48000)).toBe('48,000 smp / 1.000 s');
  });

  it('selectionReadout shows bounds plus extent with a selection', () => {
    expect(selectionReadout({ startFrame: 12000, endFrame: 24000 }, 48000, 48000)).toBe(
      '12,000-24,000 smp (12,000 smp / 0.250 s)',
    );
  });
});

describe('SampleViewport', () => {
  it('starts fitted: the whole file spans the width', () => {
    const view = new SampleViewport(8000, 800);
    expect(view.framesPerPx).toBe(10);
    expect(view.startFrame).toBe(0);
    expect(view.endFrame).toBe(8000);
  });

  it('maps x to frames and back', () => {
    const view = new SampleViewport(8000, 800);
    expect(view.xToFrame(100)).toBe(1000);
    expect(view.frameToX(1000)).toBe(100);
    expect(view.frameToX(view.xToFrame(123.4))).toBeCloseTo(123.4, 9);
  });

  it('zoomAt keeps the frame under the anchor fixed', () => {
    const view = new SampleViewport(8000, 800);
    const anchorFrame = view.xToFrame(200);
    view.zoomAt(200, 0.5);
    expect(view.framesPerPx).toBe(5);
    expect(view.xToFrame(200)).toBeCloseTo(anchorFrame, 9);
  });

  it('cannot zoom out past whole-file fit or in past the hard limit', () => {
    const view = new SampleViewport(8000, 800);
    view.zoomAt(0, 100);
    expect(view.framesPerPx).toBe(10); // fit
    view.zoomAt(0, 1e-9);
    expect(view.framesPerPx).toBe(MIN_FRAMES_PER_PX);
    view.zoomAt(0, -1); // ignored
    expect(view.framesPerPx).toBe(MIN_FRAMES_PER_PX);
  });

  it('clamps scrolling to the file extent', () => {
    const view = new SampleViewport(8000, 800);
    view.zoomAt(0, 0.5); // 5 frames/px => 4000 visible
    view.scrollByPx(10_000);
    expect(view.startFrame).toBe(4000); // 8000 - 800*5
    expect(view.endFrame).toBe(8000);
    view.scrollByPx(-99_999);
    expect(view.startFrame).toBe(0);
  });

  it('resize re-clamps zoom and scroll', () => {
    const view = new SampleViewport(8000, 800);
    view.zoomAt(0, 0.5);
    view.scrollByPx(10_000);
    view.resize(1600); // visible extent doubles; max start shrinks to 0
    expect(view.widthPx).toBe(1600);
    expect(view.startFrame).toBe(0);
  });

  it('setTotalFrames re-clamps after a length-changing edit', () => {
    const view = new SampleViewport(8000, 800);
    view.zoomAt(0, 0.5);
    view.scrollByPx(10_000); // start 4000
    view.setTotalFrames(4000);
    expect(view.startFrame).toBe(0);
    expect(view.endFrame).toBe(4000);
  });

  it('zoomToFit restores the whole-file view', () => {
    const view = new SampleViewport(8000, 800);
    view.zoomAt(400, 0.1);
    view.zoomToFit();
    expect(view.startFrame).toBe(0);
    expect(view.endFrame).toBe(8000);
    expect(view.framesPerPx).toBe(10);
  });

  it('caps the zoom of tiny files at the hard limit', () => {
    const view = new SampleViewport(10, 800);
    expect(view.framesPerPx).toBe(MIN_FRAMES_PER_PX);
    expect(view.startFrame).toBe(0);
  });
});
