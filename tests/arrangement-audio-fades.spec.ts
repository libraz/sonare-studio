import { describe, expect, it } from 'vitest';
import {
  clampFadePpq,
  clipRenderTopPx,
  clipRenderWidthPx,
  FADE_HANDLE_BAND_PX,
  FADE_HANDLE_SIZE_PX,
  FADE_HANDLE_TOLERANCE_PX,
  fadeHandleRect,
  fadeHandlesVisible,
  fadeHandleXs,
  hitTestFadeHandles,
} from '@/ui/arrangement/audio-fades';

// Clip rectangle x [40, 120) with its top at y = 0 (10 px per PPQ).
const rect = { left: 40, right: 120, top: 0 };

describe('fadeHandleXs', () => {
  it('places handles at the fade boundaries', () => {
    expect(fadeHandleXs(40, 120, 1, 2, 10)).toEqual({ inX: 50, outX: 100 });
  });

  it('places handles at the clip edges when there are no fades', () => {
    expect(fadeHandleXs(40, 120, 0, 0, 10)).toEqual({ inX: 40, outX: 120 });
  });

  it('clamps handles into the clip extent', () => {
    expect(fadeHandleXs(40, 120, 100, 0, 10)).toEqual({ inX: 120, outX: 120 });
    expect(fadeHandleXs(40, 120, 0, 100, 10)).toEqual({ inX: 40, outX: 40 });
  });

  it('treats negative fades as zero', () => {
    expect(fadeHandleXs(40, 120, -1, -2, 10)).toEqual({ inX: 40, outX: 120 });
  });
});

describe('fade handle visibility geometry', () => {
  it('shares the rendered clip width and top coordinates', () => {
    expect(clipRenderWidthPx(0.8, 10)).toBe(7);
    expect(clipRenderTopPx(0)).toBe(2);
    expect(fadeHandleRect(40, 2, clipRenderWidthPx(0.8, 10))).toEqual({
      left: 40,
      right: 47,
      top: 2,
    });
  });

  it('only exposes handles when the rendered clip is wide enough', () => {
    expect(fadeHandlesVisible(fadeHandleRect(40, 2, FADE_HANDLE_SIZE_PX * 2 - 1))).toBe(false);
    expect(fadeHandlesVisible(fadeHandleRect(40, 2, FADE_HANDLE_SIZE_PX * 2))).toBe(true);
  });
});

describe('hitTestFadeHandles', () => {
  it('hits the fade-in handle within the tolerance', () => {
    expect(hitTestFadeHandles({ x: 50, y: 3 }, rect, 1, 0, 10)).toBe('in');
    expect(hitTestFadeHandles({ x: 50 + FADE_HANDLE_TOLERANCE_PX, y: 3 }, rect, 1, 0, 10)).toBe(
      'in',
    );
    expect(hitTestFadeHandles({ x: 50 + FADE_HANDLE_TOLERANCE_PX + 1, y: 3 }, rect, 1, 0, 10)).toBe(
      null,
    );
  });

  it('hits the fade-out handle near the right boundary', () => {
    expect(hitTestFadeHandles({ x: 99, y: 3 }, rect, 0, 2, 10)).toBe('out');
  });

  it('only hits inside the top band', () => {
    expect(hitTestFadeHandles({ x: 50, y: FADE_HANDLE_BAND_PX }, rect, 1, 0, 10)).toBe(null);
    expect(hitTestFadeHandles({ x: 50, y: -1 }, rect, 1, 0, 10)).toBe(null);
    expect(hitTestFadeHandles({ x: 50, y: FADE_HANDLE_BAND_PX - 1 }, rect, 1, 0, 10)).toBe('in');
  });

  it('prefers the nearer handle and fade-in on a tie', () => {
    // Both handles collapse onto the left edge: fade-in wins the tie.
    expect(hitTestFadeHandles({ x: 40, y: 3 }, rect, 0, 8, 10)).toBe('in');
    // Out handle is closer.
    expect(hitTestFadeHandles({ x: 118, y: 3 }, rect, 7, 0.1, 10)).toBe('out');
  });

  it('honors a custom tolerance', () => {
    expect(hitTestFadeHandles({ x: 60, y: 3 }, rect, 1, 0, 10, { tolerancePx: 10 })).toBe('in');
    expect(hitTestFadeHandles({ x: 60, y: 3 }, rect, 1, 0, 10, { tolerancePx: 2 })).toBe(null);
  });

  it('does not hit a handle in a narrow or outside portion of the clip', () => {
    const narrow = fadeHandleRect(40, 0, FADE_HANDLE_SIZE_PX * 2 - 1);
    expect(hitTestFadeHandles({ x: 40, y: 3 }, narrow, 0, 0, 10)).toBe(null);
    expect(hitTestFadeHandles({ x: 34, y: 3 }, rect, 0, 0, 10)).toBe(null);
    expect(hitTestFadeHandles({ x: 120, y: 3 }, rect, 0, 0, 10)).toBe(null);
  });
});

describe('clampFadePpq', () => {
  it('keeps an in-range fade unchanged', () => {
    expect(clampFadePpq(5, 8, 0)).toBe(5);
  });

  it('clamps to the clip length and to zero', () => {
    expect(clampFadePpq(9, 8, 0)).toBe(8);
    expect(clampFadePpq(-1, 8, 0)).toBe(0);
  });

  it('never crosses the opposite fade', () => {
    expect(clampFadePpq(7, 8, 5)).toBe(3);
    expect(clampFadePpq(5, 8, 10)).toBe(0);
  });
});
