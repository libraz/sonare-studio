/**
 * Pure geometry for anchored tour tooltips. Given the anchor rectangle, the
 * tooltip size and the viewport size, picks the side of the anchor to place
 * the tooltip on (flipping to the opposite side when the preferred side lacks
 * room) and clamps the final position so the tooltip stays inside the
 * viewport. No DOM access; callers measure elements and pass plain rects.
 */

/** Axis-aligned rectangle in viewport coordinates (CSS pixels). */
export interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Width/height pair in CSS pixels. */
export interface Size {
  width: number;
  height: number;
}

/** Side of the anchor a tooltip is placed on. */
export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

/** Resolved tooltip position (top-left corner) plus the side actually used. */
export interface TooltipPlacement {
  left: number;
  top: number;
  /** Side of the anchor the tooltip ended up on (after any flip). */
  side: TooltipSide;
}

/** Options for {@link placeTooltip}. */
export interface PlaceTooltipOptions {
  /** Anchor rectangle in viewport coordinates. */
  anchor: AnchorRect;
  /** Measured tooltip size. */
  tooltip: Size;
  /** Viewport size the tooltip must stay within. */
  viewport: Size;
  /** Preferred side of the anchor (default 'bottom'). */
  side?: TooltipSide;
  /** Distance between the anchor edge and the tooltip edge (default 12). */
  gap?: number;
  /** Minimum distance kept from the viewport edges (default 8). */
  margin?: number;
}

/** Default anchor-to-tooltip distance in CSS pixels. */
export const DEFAULT_TOOLTIP_GAP = 12;

/** Default minimum distance from viewport edges in CSS pixels. */
export const DEFAULT_TOOLTIP_MARGIN = 8;

const OPPOSITE: Record<TooltipSide, TooltipSide> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

/** Clamps `value` into `[min, max]`; when max < min the lower bound wins. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * Free space available on one side of the anchor, between the anchor edge and
 * the viewport edge (margins not yet subtracted).
 */
function sideSpace(side: TooltipSide, anchor: AnchorRect, viewport: Size): number {
  switch (side) {
    case 'top':
      return anchor.top;
    case 'bottom':
      return viewport.height - (anchor.top + anchor.height);
    case 'left':
      return anchor.left;
    case 'right':
      return viewport.width - (anchor.left + anchor.width);
  }
}

/** Tooltip extent along the main axis of `side`. */
function mainSize(side: TooltipSide, tooltip: Size): number {
  return side === 'top' || side === 'bottom' ? tooltip.height : tooltip.width;
}

/**
 * Places a tooltip next to an anchor.
 *
 * The preferred side is used when the tooltip (plus gap and margin) fits in
 * the space between the anchor and the viewport edge; otherwise the opposite
 * side is tried, and when neither fits the side with more free space wins.
 * The final position is clamped on both axes so the tooltip never overflows
 * the viewport (when the viewport is smaller than the tooltip, the top-left
 * margin wins).
 */
export function placeTooltip(options: PlaceTooltipOptions): TooltipPlacement {
  const { anchor, tooltip, viewport } = options;
  const preferred = options.side ?? 'bottom';
  const gap = options.gap ?? DEFAULT_TOOLTIP_GAP;
  const margin = options.margin ?? DEFAULT_TOOLTIP_MARGIN;

  const fits = (side: TooltipSide): boolean =>
    sideSpace(side, anchor, viewport) >= mainSize(side, tooltip) + gap + margin;

  let side = preferred;
  if (!fits(preferred)) {
    const opposite = OPPOSITE[preferred];
    if (fits(opposite)) {
      side = opposite;
    } else if (sideSpace(opposite, anchor, viewport) > sideSpace(preferred, anchor, viewport)) {
      side = opposite;
    }
  }

  // Raw position: centered on the cross axis, offset by the gap on the main axis.
  let left: number;
  let top: number;
  switch (side) {
    case 'top':
      left = anchor.left + anchor.width / 2 - tooltip.width / 2;
      top = anchor.top - gap - tooltip.height;
      break;
    case 'bottom':
      left = anchor.left + anchor.width / 2 - tooltip.width / 2;
      top = anchor.top + anchor.height + gap;
      break;
    case 'left':
      left = anchor.left - gap - tooltip.width;
      top = anchor.top + anchor.height / 2 - tooltip.height / 2;
      break;
    case 'right':
      left = anchor.left + anchor.width + gap;
      top = anchor.top + anchor.height / 2 - tooltip.height / 2;
      break;
  }

  return {
    left: clamp(left, margin, viewport.width - tooltip.width - margin),
    top: clamp(top, margin, viewport.height - tooltip.height - margin),
    side,
  };
}
