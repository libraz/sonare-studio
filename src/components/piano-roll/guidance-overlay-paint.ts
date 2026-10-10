/**
 * Pure canvas painters for the note grid's guidance overlay: the placement
 * column (per-pitch safe/warn/ng tint, hatch and resolution arrows) and the
 * voice-leading resolution arrows.
 */

import type { ResolutionArrow } from '@/composables/useCompositionGuidance';
import type { PlacementColumn } from '@/composables/usePlacementGuidance';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { PIANO_ROLL_COLORS } from './theme';

const COLORS = PIANO_ROLL_COLORS;

/** Horizontal length of a resolution arrow in px (from the note's right edge). */
const RESOLUTION_ARROW_LENGTH_PX = 16;
/** Size of the resolution arrowhead in px. */
const RESOLUTION_ARROWHEAD_PX = 4;

/** Strokes one resolution arrow (dashed shaft when `dash` is given) with a solid head. */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  dash: number[] = [],
): void {
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.setLineDash([]);
  // Arrowhead: a small filled triangle pointing along the arrow direction.
  const angle = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(
    x1 - RESOLUTION_ARROWHEAD_PX * Math.cos(angle - Math.PI / 6),
    y1 - RESOLUTION_ARROWHEAD_PX * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    x1 - RESOLUTION_ARROWHEAD_PX * Math.cos(angle + Math.PI / 6),
    y1 - RESOLUTION_ARROWHEAD_PX * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
}

/**
 * Draws thin arrows from each resolving note's right edge to the row of its
 * expected resolution pitch, so voice-leading obligations (suspensions, leading
 * tones, needs-resolution notes) read at a glance. Arrows whose origin is off
 * screen or whose both endpoints sit outside the visible pitch band are culled.
 */
export function drawResolutionArrows(
  ctx: CanvasRenderingContext2D,
  range: TimelineRange,
  arrows: ReadonlyArray<ResolutionArrow> | undefined,
  w: number,
  h: number,
): void {
  if (arrows === undefined || arrows.length === 0) return;
  const rowMid = range.rowHeight / 2;
  ctx.strokeStyle = COLORS.resolutionArrow;
  ctx.fillStyle = COLORS.resolutionArrow;
  ctx.lineWidth = 1.5;
  for (const arrow of arrows) {
    const x0 = range.ppqToX(arrow.endBeat);
    if (x0 < -RESOLUTION_ARROW_LENGTH_PX || x0 > w) continue;
    const y0 = range.pitchToY(arrow.fromPitch) + rowMid;
    const y1 = range.pitchToY(arrow.toPitch) + rowMid;
    if ((y0 < 0 && y1 < 0) || (y0 > h && y1 > h)) continue;
    drawArrow(ctx, x0, y0, x0 + RESOLUTION_ARROW_LENGTH_PX, y1);
  }
}

/** Rows shorter than this skip the ng hatch, which would only smear. */
const PLACEMENT_HATCH_MIN_ROW_PX = 5;
/** Horizontal spacing between ng hatch strokes, in px. */
const PLACEMENT_HATCH_SPACING_PX = 4;
/** Dash pattern of the thinning underline and the placement resolution arrow. */
const PLACEMENT_DASH = [2, 2];

/** Diagonal strokes clipped to one ng row of the placement column. */
function drawHatch(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y: number,
  width: number,
  height: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y, width, height);
  ctx.clip();
  ctx.beginPath();
  for (let x = x0 - height; x < x0 + width; x += PLACEMENT_HATCH_SPACING_PX) {
    ctx.moveTo(x, y + height);
    ctx.lineTo(x + height, y);
  }
  ctx.strokeStyle = COLORS.placementHatch;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

/**
 * Paints the pencil's placement column: a safe/warn/ng tint per pitch row, a
 * hatch over ng rows, a dotted underline where the note thins a following
 * accompaniment, 1px edges, and — for a hovered warn row — dotted arrows to its
 * resolution pitches.
 */
export function drawPlacementColumn(
  ctx: CanvasRenderingContext2D,
  range: TimelineRange,
  column: PlacementColumn | null | undefined,
  hoveredPitch: number | null,
  w: number,
  h: number,
): void {
  if (!column) return;
  const left = range.ppqToX(column.startPpq);
  const right = range.ppqToX(column.endPpq);
  const x0 = Math.max(0, left);
  const x1 = Math.min(w, right);
  if (x1 <= x0) return;
  const rowH = range.rowHeight;
  const lowPitch = Math.max(0, range.yToPitch(h - 1));
  const highPitch = Math.min(column.verdicts.length - 1, range.yToPitch(0));
  const hatch = rowH >= PLACEMENT_HATCH_MIN_ROW_PX;
  for (let pitch = lowPitch; pitch <= highPitch; pitch++) {
    const verdict = column.verdicts[pitch];
    if (verdict === undefined) continue;
    const y = range.pitchToY(pitch);
    ctx.fillStyle =
      verdict.level === 'ng'
        ? COLORS.guidanceDissonant
        : verdict.level === 'warn'
          ? COLORS.guidanceWarning
          : COLORS.guidanceSafe;
    ctx.fillRect(x0, y, x1 - x0, rowH);
    if (verdict.level === 'ng' && hatch) drawHatch(ctx, x0, y, x1 - x0, rowH);
    if (verdict.level === 'safe' && verdict.reasons.includes('accompanimentThinned')) {
      ctx.strokeStyle = COLORS.placementThinned;
      ctx.lineWidth = 1;
      ctx.setLineDash(PLACEMENT_DASH);
      ctx.beginPath();
      ctx.moveTo(x0 + 1, y + rowH - 1.5);
      ctx.lineTo(x1 - 1, y + rowH - 1.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.fillStyle = COLORS.placementEdge;
  if (left >= 0 && left <= w) ctx.fillRect(Math.round(left), 0, 1, h);
  if (right >= 0 && right <= w) ctx.fillRect(Math.round(right) - 1, 0, 1, h);

  if (hoveredPitch === null) return;
  const verdict = column.verdicts[hoveredPitch];
  if (verdict?.level !== 'warn' || !verdict.resolveTo || verdict.resolveTo.length === 0) return;
  const rowMid = rowH / 2;
  ctx.strokeStyle = COLORS.resolutionArrow;
  ctx.fillStyle = COLORS.resolutionArrow;
  ctx.lineWidth = 1.5;
  for (const target of verdict.resolveTo) {
    drawArrow(
      ctx,
      right,
      range.pitchToY(hoveredPitch) + rowMid,
      right + RESOLUTION_ARROW_LENGTH_PX,
      range.pitchToY(target) + rowMid,
      PLACEMENT_DASH,
    );
  }
}
