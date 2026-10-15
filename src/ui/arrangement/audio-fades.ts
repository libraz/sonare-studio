import { clampClipFadePpq } from '@/project/clip-fades';
import { MIN_CLIP_WIDTH_PX } from './clip-hit';

/**
 * Fade handle geometry for audio clips on the arrangement canvas: handle
 * positions at the clip's top corners, hit-testing against a pointer, and
 * fade length clamping. Pure geometry: rendering and gesture state live
 * elsewhere.
 */

/** Which fade of a clip a handle or gesture addresses. */
export type FadeEdge = 'in' | 'out';

/** Default px distance from a fade handle center that still counts as a hit. */
export const FADE_HANDLE_TOLERANCE_PX = 6;

/** Height of the band below the clip top where fade handles are grabbable. */
export const FADE_HANDLE_BAND_PX = 12;

/** Rendered size (base width and height) of a fade handle triangle, in px. */
export const FADE_HANDLE_SIZE_PX = 8;

/** Minimum width of the rendered clip rectangle before both fade handles appear. */
const MIN_FADE_HANDLE_CLIP_WIDTH_PX = FADE_HANDLE_SIZE_PX * 2;

/** Width of an arrangement clip as used by the canvas renderer. */
export function clipRenderWidthPx(lengthPpq: number, pxPerPpq: number): number {
  return Math.max(MIN_CLIP_WIDTH_PX, lengthPpq * pxPerPpq - 1);
}

/** Top edge of an arrangement clip's rendered rectangle for a lane top. */
export function clipRenderTopPx(laneTopPx: number): number {
  return laneTopPx + 2;
}

/** Horizontal positions of both fade handles, in viewport px. */
export interface FadeHandleXs {
  /** Fade-in handle x (clip left edge + fade-in length). */
  inX: number;
  /** Fade-out handle x (clip right edge - fade-out length). */
  outX: number;
}

/**
 * Computes the x positions of the fade handles of a clip rectangle. Handles
 * sit at the end of the fade-in ramp and the start of the fade-out ramp,
 * clamped into the clip's horizontal extent.
 *
 * @param leftX - Clip left edge in viewport px.
 * @param rightX - Clip right edge in viewport px (>= leftX).
 * @param fadeInPpq - Fade-in length in PPQ (>= 0).
 * @param fadeOutPpq - Fade-out length in PPQ (>= 0).
 * @param pxPerPpq - Horizontal zoom in px per PPQ.
 * @returns Both handle positions.
 */
export function fadeHandleXs(
  leftX: number,
  rightX: number,
  fadeInPpq: number,
  fadeOutPpq: number,
  pxPerPpq: number,
): FadeHandleXs {
  return {
    inX: Math.min(rightX, leftX + Math.max(0, fadeInPpq) * pxPerPpq),
    outX: Math.max(leftX, rightX - Math.max(0, fadeOutPpq) * pxPerPpq),
  };
}

/** The clip rectangle extent needed for fade handle hit-testing. */
export interface FadeHandleRect {
  /** Clip left edge in viewport px. */
  left: number;
  /** Clip right edge in viewport px. */
  right: number;
  /** Rendered clip top edge in viewport px. */
  top: number;
}

/** Builds the fade-handle rectangle from the rendered clip geometry. */
export function fadeHandleRect(left: number, top: number, width: number): FadeHandleRect {
  return { left, right: left + width, top };
}

/** Whether the renderer draws the pair of fade handles for this rectangle. */
export function fadeHandlesVisible(rect: FadeHandleRect): boolean {
  return rect.right - rect.left >= MIN_FADE_HANDLE_CLIP_WIDTH_PX;
}

/** Options for {@link hitTestFadeHandles}. */
export interface FadeHandleHitOptions {
  /** Px distance from a handle treated as a hit. Default {@link FADE_HANDLE_TOLERANCE_PX}. */
  tolerancePx?: number;
  /** Grabbable band height below the clip top. Default {@link FADE_HANDLE_BAND_PX}. */
  bandPx?: number;
}

/**
 * Tests a pointer against both fade handles of a clip. Only the band just
 * below the clip top counts, so the clip body and trim edges stay reachable
 * underneath. When both handles are in range the nearer one wins (the
 * fade-in handle on a tie).
 *
 * @param point - Pointer position in viewport px.
 * @param rect - Clip rectangle extent.
 * @param fadeInPpq - Current fade-in length in PPQ (>= 0).
 * @param fadeOutPpq - Current fade-out length in PPQ (>= 0).
 * @param pxPerPpq - Horizontal zoom in px per PPQ.
 * @param options - Tolerance configuration.
 * @returns The hit fade edge, or null when neither handle is hit.
 */
export function hitTestFadeHandles(
  point: { x: number; y: number },
  rect: FadeHandleRect,
  fadeInPpq: number,
  fadeOutPpq: number,
  pxPerPpq: number,
  options: FadeHandleHitOptions = {},
): FadeEdge | null {
  const tolerance = options.tolerancePx ?? FADE_HANDLE_TOLERANCE_PX;
  const band = options.bandPx ?? FADE_HANDLE_BAND_PX;
  if (
    !fadeHandlesVisible(rect) ||
    point.x < rect.left ||
    point.x >= rect.right ||
    point.y < rect.top ||
    point.y >= rect.top + band
  ) {
    return null;
  }
  const { inX, outX } = fadeHandleXs(rect.left, rect.right, fadeInPpq, fadeOutPpq, pxPerPpq);
  const dIn = Math.abs(point.x - inX);
  const dOut = Math.abs(point.x - outX);
  if (dIn <= tolerance && dIn <= dOut) return 'in';
  if (dOut <= tolerance) return 'out';
  return null;
}

/**
 * Clamps a fade length so it stays inside the clip and never crosses the
 * opposite fade.
 *
 * @param targetPpq - Requested fade length in PPQ.
 * @param clipLengthPpq - Clip length in PPQ (> 0).
 * @param otherFadePpq - Length of the opposite fade in PPQ (>= 0).
 * @returns The clamped fade length in [0, clipLengthPpq - otherFadePpq].
 */
export function clampFadePpq(
  targetPpq: number,
  clipLengthPpq: number,
  otherFadePpq: number,
): number {
  return clampClipFadePpq(targetPpq, clipLengthPpq, otherFadePpq);
}
