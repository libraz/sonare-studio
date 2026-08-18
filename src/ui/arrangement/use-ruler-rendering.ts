/**
 * Base-layer background rendering for the arrangement canvas: track lane
 * backgrounds and separators, the beat/bar gridlines over the lanes, and the
 * top ruler strip (loop band, ticks, bar-number labels and marker flags).
 *
 * Pure drawing helpers: each takes the 2D context plus an explicit parameter
 * object, so geometry and colors are computed exactly as the canvas owns them.
 */

import { type ARRANGEMENT_COLORS, RULER_HEIGHT_PX } from '@/components/arrangement/theme';
import type { EditorMarker, EditorTrack, TimeSignatureSegment } from '@/project/types';
import type { RulerTick } from '@/ui/arrangement/ruler';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { CANVAS_FONT_SIZE_PX, canvasFont } from '@/ui/theme/tokens';

type ArrangementColors = typeof ARRANGEMENT_COLORS;

/** Cached ruler-tick getter shared by the grid and the ruler strip. */
export type RulerTickGetter = (
  meter: ReadonlyArray<TimeSignatureSegment>,
  startPpq: number,
  endPpq: number,
  pxPerPpq: number,
) => RulerTick[];

/** Inputs for {@link drawLanes}. */
export interface DrawLanesContext {
  /** Tracks in lane order. */
  tracks: EditorTrack[];
  /** Id of the active track (its lane is tinted). */
  activeTrackId: number;
  /** Height of one track lane in px. */
  laneHeight: number;
  /** Resolves the viewport y of a row's top edge (index = total height row). */
  laneTop: (index: number) => number;
  /** Resolves the full height of a row (lane plus sublanes when expanded). */
  rowHeight: (index: number) => number;
  /** Color tokens. */
  colors: ArrangementColors;
}

/**
 * Draws lane backgrounds, separators and the below-tracks shade.
 *
 * @param ctx - Target 2D context.
 * @param w - Canvas width in px.
 * @param h - Canvas height in px.
 * @param context - Lane geometry and colors.
 */
export function drawLanes(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  context: DrawLanesContext,
): void {
  const { tracks, activeTrackId, laneHeight, laneTop, rowHeight, colors } = context;
  for (let i = 0; i < tracks.length; i++) {
    const y = laneTop(i);
    const height = rowHeight(i);
    if (y + height <= RULER_HEIGHT_PX || y >= h) continue;
    ctx.fillStyle = i % 2 === 0 ? colors.laneEven : colors.laneOdd;
    ctx.fillRect(0, y, w, height);
    if (tracks[i].id === activeTrackId) {
      ctx.fillStyle = colors.laneActive;
      ctx.fillRect(0, y, w, laneHeight);
    }
    ctx.fillStyle = colors.laneLine;
    ctx.fillRect(0, y + height - 1, w, 1);
  }
  const lanesEnd = laneTop(tracks.length);
  if (lanesEnd < h) {
    ctx.fillStyle = colors.beyondTracks;
    ctx.fillRect(
      0,
      Math.max(RULER_HEIGHT_PX, lanesEnd),
      w,
      h - Math.max(RULER_HEIGHT_PX, lanesEnd),
    );
  }
}

/** Inputs for {@link drawGrid}. */
export interface DrawGridContext {
  /** Timeline viewport. */
  range: TimelineRange;
  /** Time-signature map driving the bar/beat ruler. */
  timeSignatures: TimeSignatureSegment[];
  /** Cached ruler-tick getter. */
  ticks: RulerTickGetter;
  /** Color tokens. */
  colors: ArrangementColors;
}

/**
 * Draws beat/bar gridlines over the lane area.
 *
 * @param ctx - Target 2D context.
 * @param h - Canvas height in px.
 * @param context - Range, meter, tick cache and colors.
 */
export function drawGrid(ctx: CanvasRenderingContext2D, h: number, context: DrawGridContext): void {
  const { range, timeSignatures, ticks, colors } = context;
  const list = ticks(timeSignatures, range.startPpq, range.endPpq, range.pxPerPpq);
  for (const tick of list) {
    ctx.fillStyle = tick.kind === 'bar' ? colors.gridBar : colors.gridBeat;
    ctx.fillRect(Math.round(range.ppqToX(tick.ppq)), RULER_HEIGHT_PX, 1, h - RULER_HEIGHT_PX);
  }
}

/** Inputs for {@link drawRuler}. */
export interface DrawRulerContext {
  /** Timeline viewport. */
  range: TimelineRange;
  /** Time-signature map driving the bar/beat ruler. */
  timeSignatures: TimeSignatureSegment[];
  /** Cached ruler-tick getter. */
  ticks: RulerTickGetter;
  /** Timeline markers rendered as flags. */
  markers: EditorMarker[];
  /** Whether the transport loop band is shown. */
  loopEnabled: boolean;
  /** Loop start in PPQ. */
  loopStartPpq: number;
  /** Loop end in PPQ. */
  loopEndPpq: number;
  /** Color tokens. */
  colors: ArrangementColors;
}

/**
 * Draws the ruler strip: loop band, ticks, labels and marker flags.
 *
 * @param ctx - Target 2D context.
 * @param w - Canvas width in px.
 * @param context - Range, meter, markers, loop state and colors.
 */
export function drawRuler(
  ctx: CanvasRenderingContext2D,
  w: number,
  context: DrawRulerContext,
): void {
  const { range, timeSignatures, ticks, markers, loopEnabled, loopStartPpq, loopEndPpq, colors } =
    context;
  ctx.fillStyle = colors.rulerBackground;
  ctx.fillRect(0, 0, w, RULER_HEIGHT_PX);

  if (loopEnabled && loopEndPpq > loopStartPpq) {
    const x1 = Math.max(0, range.ppqToX(loopStartPpq));
    const x2 = Math.min(w, range.ppqToX(loopEndPpq));
    if (x2 > x1) {
      ctx.fillStyle = colors.loopOverlay;
      ctx.fillRect(x1, 0, x2 - x1, RULER_HEIGHT_PX);
    }
  }

  const list = ticks(timeSignatures, range.startPpq, range.endPpq, range.pxPerPpq);
  ctx.font = canvasFont(CANVAS_FONT_SIZE_PX.meta);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const tick of list) {
    const x = Math.round(range.ppqToX(tick.ppq));
    if (tick.kind === 'bar') {
      ctx.fillStyle = colors.rulerBar;
      ctx.fillRect(x, RULER_HEIGHT_PX - 12, 1, 12);
      if (tick.label) {
        ctx.fillStyle = colors.rulerLabel;
        ctx.fillText(tick.label, x + 3, RULER_HEIGHT_PX - 16);
      }
    } else {
      ctx.fillStyle = colors.rulerBeat;
      ctx.fillRect(x, RULER_HEIGHT_PX - 6, 1, 6);
    }
  }

  for (const marker of markers) {
    const x = Math.round(range.ppqToX(marker.ppq));
    if (x < -40 || x > w) continue;
    ctx.fillStyle = colors.markerFlag;
    ctx.fillRect(x, 2, 1, RULER_HEIGHT_PX - 2);
    ctx.beginPath();
    ctx.moveTo(x, 2);
    ctx.lineTo(x + 7, 6);
    ctx.lineTo(x, 10);
    ctx.closePath();
    ctx.fill();
    if (marker.name) {
      ctx.fillStyle = colors.markerLabel;
      ctx.fillText(marker.name, x + 9, 10);
    }
  }

  ctx.fillStyle = colors.rulerBorder;
  ctx.fillRect(0, RULER_HEIGHT_PX - 1, w, 1);
}
