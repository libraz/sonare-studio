/**
 * Take sub-row rendering for the arrangement base layer: per expanded track a
 * shaded band with per-take separators, then for each comped clip a subtle
 * block over its span, a stronger fill on the ranges where the comp selection
 * plays each take, and (while a comp drag runs) a highlight over the dragged
 * range.
 *
 * Pure drawing helpers: each takes the 2D context plus an explicit parameter
 * object, so geometry and colors are computed exactly as the canvas owns them.
 */

import {
  type ARRANGEMENT_COLORS,
  colorWithAlpha,
  RULER_HEIGHT_PX,
} from '@/components/arrangement/theme';
import { fillRoundRect, strokeRoundRect } from '@/components/piano-roll/theme';
import { sanitizeCompSegments } from '@/project/comping';
import type { EditorClip, EditorTrack } from '@/project/types';
import { TAKE_LANE_HEIGHT_PX, trackTakeRowCount } from '@/ui/arrangement/automation-rows';
import type { TakeInteractions } from '@/ui/arrangement/use-take-interactions';
import type { TimelineRange } from '@/ui/canvas/timeline-range';

type ArrangementColors = typeof ARRANGEMENT_COLORS;

/** Vertical inset of a take block inside its sub-row, in px. */
export const TAKE_BLOCK_PAD_PX = 3;

/** Shared state the take sub-row drawing reads from the canvas. */
export interface TakeLanesContext {
  /** Timeline viewport. */
  range: TimelineRange;
  /** Tracks in lane order. */
  tracks: EditorTrack[];
  /** Clips to render (store mirror). */
  clips: EditorClip[];
  /** Ids of tracks whose take sub-rows are expanded. */
  takesExpandedIds: readonly number[];
  /** Take sub-row gesture state (drag preview source). */
  takes: TakeInteractions;
  /** Vertical scroll offset of the lane area in px. */
  scrollY: number;
  /** Resolves the content-px top of a row's first take sub-row. */
  takeTop: (index: number, takeIndex: number) => number;
  /** Color tokens. */
  colors: ArrangementColors;
}

/**
 * Draws every expanded take sub-row area: shade, separators and take blocks.
 *
 * @param ctx - Target 2D context.
 * @param w - Canvas width in px.
 * @param h - Canvas height in px.
 * @param context - Shared rendering state.
 */
export function drawTakeLanes(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  context: TakeLanesContext,
): void {
  const { tracks, clips, takesExpandedIds, scrollY, takeTop, colors } = context;
  const takesExpanded = new Set(takesExpandedIds);
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (!takesExpanded.has(track.id)) continue;
    const rowCount = trackTakeRowCount(clips, track.id);
    if (rowCount === 0) continue;
    const top = RULER_HEIGHT_PX + takeTop(i, 0) - scrollY;
    const height = rowCount * TAKE_LANE_HEIGHT_PX;
    if (top + height <= RULER_HEIGHT_PX || top >= h) continue;
    ctx.fillStyle = colors.takeLane;
    ctx.fillRect(0, top, w, height);
    ctx.fillStyle = colors.laneLine;
    for (let k = 1; k < rowCount; k++) {
      ctx.fillRect(0, top + k * TAKE_LANE_HEIGHT_PX, w, 1);
    }
    for (const clip of clips) {
      if (
        clip.trackId !== track.id ||
        Math.max(clip.takes?.length ?? 0, clip.midiTakes?.length ?? 0) === 0
      )
        continue;
      drawClipTakeBlocks(ctx, clip, track, top, context);
    }
  }
}

/**
 * Draws one comped clip's take blocks: in take sub-row k a subtle block over
 * the clip's span, a stronger fill on the ranges where the comp selection
 * plays take k and, while a comp drag runs, a highlight over the dragged
 * range.
 *
 * @param ctx - Target 2D context.
 * @param clip - Comped clip being rendered.
 * @param track - Track owning the clip.
 * @param top - Take sub-row area top edge in viewport px.
 * @param context - Shared rendering state.
 */
export function drawClipTakeBlocks(
  ctx: CanvasRenderingContext2D,
  clip: EditorClip,
  track: EditorTrack,
  top: number,
  context: TakeLanesContext,
): void {
  const { range, takes, colors } = context;
  const clipTakes = clip.takes ?? clip.midiTakes ?? [];
  const x = range.ppqToX(clip.startPpq);
  const wPx = Math.max(2, clip.lengthPpq * range.pxPerPpq - 1);
  if (x + wPx < 0 || x > range.widthPx) return;
  const selection =
    clip.midiTakes !== undefined
      ? sanitizeCompSegments(
          clip.midiCompSegments ?? [
            {
              startPpq: 0,
              takeIndex: Math.min(
                Math.max(0, clip.midiActiveTakeIndex ?? clip.midiTakes.length - 1),
                clip.midiTakes.length - 1,
              ),
            },
          ],
          clip.midiTakes.length,
          clip.lengthPpq,
        )
      : sanitizeCompSegments(
          clip.compSegments && clip.compSegments.length > 0
            ? clip.compSegments
            : [{ startPpq: 0, takeIndex: 0 }],
          clipTakes.length,
          clip.lengthPpq,
        );
  const preview = takes.preview.value;
  for (let k = 0; k < clipTakes.length; k++) {
    const y = top + k * TAKE_LANE_HEIGHT_PX + TAKE_BLOCK_PAD_PX;
    const hPx = TAKE_LANE_HEIGHT_PX - 2 * TAKE_BLOCK_PAD_PX;
    ctx.fillStyle = colorWithAlpha(track.color, 0.14);
    fillRoundRect(ctx, x, y, wPx, hPx, 2);
    ctx.fillStyle = colorWithAlpha(track.color, 0.55);
    for (let s = 0; s < selection.length; s++) {
      if (selection[s].takeIndex !== k) continue;
      const segStart = selection[s].startPpq;
      const segEnd = s + 1 < selection.length ? selection[s + 1].startPpq : clip.lengthPpq;
      const sx = range.ppqToX(clip.startPpq + segStart);
      const sw = Math.max(1, (segEnd - segStart) * range.pxPerPpq - 1);
      ctx.fillRect(sx, y, sw, hPx);
    }
    if (
      preview &&
      preview.clipId === clip.id &&
      preview.takeIndex === k &&
      preview.endPpq > preview.startPpq
    ) {
      ctx.fillStyle = colorWithAlpha(track.color, 0.75);
      const px = range.ppqToX(clip.startPpq + preview.startPpq);
      const pw = Math.max(1, (preview.endPpq - preview.startPpq) * range.pxPerPpq);
      ctx.fillRect(px, y, pw, hPx);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = colors.clipBorder;
    strokeRoundRect(ctx, x + 0.5, y + 0.5, wPx - 1, hPx - 1, 2);
  }
}
