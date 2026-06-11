import { describe, expect, it } from 'vitest';
import {
  clampFadePpq,
  FADE_HANDLE_BAND_PX,
  FADE_HANDLE_TOLERANCE_PX,
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
