/**
 * Hit-testing for clip rectangles on the arrangement canvas. Clips live in
 * horizontal track lanes instead of pitch rows, so this mirrors the note
 * hit-test with a lane-based view contract. Pure geometry: rendering and
 * input handling live elsewhere.
 */

/** A clip's extent on the arrangement surface, keyed by lane index. */
export interface ArrangeClipRect {
  /** Stable clip id. */
  id: number;
  /** Index of the track lane the clip sits in (0 = top lane). */
  laneIndex: number;
  /** Clip start in PPQ. */
  startPpq: number;
  /** Clip length in PPQ (> 0). */
  lengthPpq: number;
}

/**
 * Minimal view contract needed to project clips into px space. The horizontal
 * half matches TimelineRange; the vertical half maps track lanes.
 */
export interface ClipLaneView {
  /** Converts a PPQ position to a viewport x coordinate in px. */
  ppqToX(ppq: number): number;
  /** Converts a viewport x coordinate to a PPQ position. */
  xToPpq(x: number): number;
  /** Top y of a track lane in viewport px (scroll and ruler offset applied). */
  laneTop(index: number): number;
  /** Lane index for a viewport y; may be out of [0, laneCount) bounds. */
  laneIndexAtY(y: number): number;
  /** Height of one track lane in px. */
  readonly laneHeight: number;
}

/** Region of a clip rectangle a point falls in. */
export type ClipHitZone = 'body' | 'trim-start' | 'trim-end';

/** Result of a successful clip hit-test. */
export interface ClipHit {
  /** Id of the hit clip. */
  id: number;
  /** Which interaction zone of the clip was hit. */
  zone: ClipHitZone;
}

/** A point in viewport px coordinates. */
export interface ClipPoint {
  x: number;
  y: number;
}

/** Default px distance from a clip edge that still counts as a trim handle. */
export const DEFAULT_TRIM_TOLERANCE_PX = 5;

/** Minimum clip width used by arrangement rendering and hit-testing. */
export const MIN_CLIP_WIDTH_PX = 2;

/** Options for {@link hitTestClip}. */
export interface ClipHitTestOptions {
  /** Px distance from a clip edge treated as a trim handle. Default {@link DEFAULT_TRIM_TOLERANCE_PX}. */
  trimTolerancePx?: number;
}

/**
 * Finds the clip under a point and the interaction zone hit.
 *
 * Clips are assumed to be drawn in array order, so the last matching clip
 * (topmost) wins when clips overlap. A point hits a clip when x is in
 * [left, right) and y is in [laneTop, laneTop + laneHeight). Within a hit,
 * x within the tolerance of the left/right edge yields 'trim-start' /
 * 'trim-end'; a clip narrower than twice the tolerance splits at its center
 * so both handles stay reachable.
 *
 * @param clips - Candidate clips in draw order (bottom to top).
 * @param point - Point in viewport px coordinates.
 * @param view - Projection from musical/lane coordinates to px.
 * @param options - Tolerance configuration.
 * @returns The topmost hit and its zone, or null when nothing is hit.
 */
export function hitTestClip(
  clips: readonly ArrangeClipRect[],
  point: ClipPoint,
  view: ClipLaneView,
  options: ClipHitTestOptions = {},
): ClipHit | null {
  const tolerance = options.trimTolerancePx ?? DEFAULT_TRIM_TOLERANCE_PX;
  for (let i = clips.length - 1; i >= 0; i--) {
    const clip = clips[i];
    const top = view.laneTop(clip.laneIndex);
    if (point.y < top || point.y >= top + view.laneHeight) continue;
    const left = view.ppqToX(clip.startPpq);
    const right = Math.max(left + MIN_CLIP_WIDTH_PX, view.ppqToX(clip.startPpq + clip.lengthPpq));
    if (point.x < left || point.x >= right) continue;
    return { id: clip.id, zone: resolveZone(point.x, left, right, tolerance) };
  }
  return null;
}

/** Resolves the interaction zone for an x position inside a clip rectangle. */
function resolveZone(x: number, left: number, right: number, tolerance: number): ClipHitZone {
  const width = right - left;
  const edgeTolerance = Math.min(tolerance, width / 3);
  if (x - left <= edgeTolerance) return 'trim-start';
  if (right - x <= edgeTolerance) return 'trim-end';
  return 'body';
}
