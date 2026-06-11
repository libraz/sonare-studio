import { describe, expect, it } from 'vitest';
import {
  type AnchorRect,
  DEFAULT_TOOLTIP_GAP,
  DEFAULT_TOOLTIP_MARGIN,
  placeTooltip,
  type Size,
} from '@/components/onboarding/tour-placement';

const viewport: Size = { width: 1000, height: 800 };
const tooltip: Size = { width: 200, height: 100 };

const anchor = (left: number, top: number, width = 100, height = 40): AnchorRect => ({
  left,
  top,
  width,
  height,
});

describe('placeTooltip', () => {
  it('places below the anchor by default, centered horizontally', () => {
    const result = placeTooltip({ anchor: anchor(400, 300), tooltip, viewport });
    expect(result.side).toBe('bottom');
    expect(result.top).toBe(300 + 40 + DEFAULT_TOOLTIP_GAP);
    // Anchor center 450, tooltip half-width 100.
    expect(result.left).toBe(350);
  });

  it('honors the preferred side when it fits', () => {
    const top = placeTooltip({ anchor: anchor(400, 300), tooltip, viewport, side: 'top' });
    expect(top.side).toBe('top');
    expect(top.top).toBe(300 - DEFAULT_TOOLTIP_GAP - 100);

    const right = placeTooltip({ anchor: anchor(400, 300), tooltip, viewport, side: 'right' });
    expect(right.side).toBe('right');
    expect(right.left).toBe(400 + 100 + DEFAULT_TOOLTIP_GAP);
    // Anchor middle 320, tooltip half-height 50.
    expect(right.top).toBe(270);
  });

  it('flips to the opposite side when the preferred side lacks room', () => {
    // Anchor near the top: 'top' cannot fit a 100px tooltip.
    const result = placeTooltip({ anchor: anchor(400, 20), tooltip, viewport, side: 'top' });
    expect(result.side).toBe('bottom');
    expect(result.top).toBe(20 + 40 + DEFAULT_TOOLTIP_GAP);
  });

  it('flips left to right near the left viewport edge', () => {
    const result = placeTooltip({ anchor: anchor(10, 300), tooltip, viewport, side: 'left' });
    expect(result.side).toBe('right');
  });

  it('keeps the preferred side when neither side fits but it has more space', () => {
    const tall: Size = { width: 200, height: 700 };
    // Anchor slightly above center: more room below than above.
    const result = placeTooltip({
      anchor: anchor(400, 300),
      tooltip: tall,
      viewport,
      side: 'bottom',
    });
    expect(result.side).toBe('bottom');
  });

  it('uses the opposite side when neither fits but it has more space', () => {
    const tall: Size = { width: 200, height: 700 };
    // Anchor near the bottom: more room above than below.
    const result = placeTooltip({
      anchor: anchor(400, 700),
      tooltip: tall,
      viewport,
      side: 'bottom',
    });
    expect(result.side).toBe('top');
  });

  it('clamps the cross axis to the viewport margin', () => {
    // Anchor hugging the left edge: centering would push the tooltip off-screen.
    const left = placeTooltip({ anchor: anchor(0, 300, 20), tooltip, viewport });
    expect(left.left).toBe(DEFAULT_TOOLTIP_MARGIN);

    const right = placeTooltip({ anchor: anchor(980, 300, 20), tooltip, viewport });
    expect(right.left).toBe(viewport.width - tooltip.width - DEFAULT_TOOLTIP_MARGIN);
  });

  it('clamps the main axis so the tooltip never overflows the viewport', () => {
    const tall: Size = { width: 200, height: 700 };
    const result = placeTooltip({
      anchor: anchor(400, 700),
      tooltip: tall,
      viewport,
      side: 'bottom',
    });
    // Flipped to top, then clamped: raw top would be negative.
    expect(result.top).toBe(DEFAULT_TOOLTIP_MARGIN);
  });

  it('prefers the top-left margin when the viewport is smaller than the tooltip', () => {
    const tiny: Size = { width: 100, height: 60 };
    const result = placeTooltip({ anchor: anchor(10, 10, 20, 20), tooltip, viewport: tiny });
    expect(result.left).toBe(DEFAULT_TOOLTIP_MARGIN);
    expect(result.top).toBe(DEFAULT_TOOLTIP_MARGIN);
  });

  it('respects custom gap and margin', () => {
    const result = placeTooltip({
      anchor: anchor(400, 300),
      tooltip,
      viewport,
      side: 'bottom',
      gap: 0,
      margin: 0,
    });
    expect(result.top).toBe(340);

    const clamped = placeTooltip({
      anchor: anchor(0, 300, 20),
      tooltip,
      viewport,
      gap: 4,
      margin: 24,
    });
    expect(clamped.left).toBe(24);
  });

  it('treats a zero-size tooltip as a point (jsdom measurements)', () => {
    const result = placeTooltip({
      anchor: anchor(400, 300),
      tooltip: { width: 0, height: 0 },
      viewport,
    });
    expect(result.side).toBe('bottom');
    expect(result.left).toBe(450);
    expect(result.top).toBe(300 + 40 + DEFAULT_TOOLTIP_GAP);
  });
});
