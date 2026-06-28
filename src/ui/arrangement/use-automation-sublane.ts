/**
 * Automation sublane rendering for the arrangement base layer: per expanded
 * track a darker shaded band with a mid-value reference line, the parameter's
 * automation curve as a polyline (regular x samples plus the exact breakpoint
 * vertices) and the breakpoint circles, honoring the live edit preview and the
 * lane's enabled state.
 *
 * Pure drawing helpers: each takes the 2D context plus an explicit parameter
 * object, so geometry and colors are computed exactly as the canvas owns them.
 */

import {
  type ARRANGEMENT_COLORS,
  colorWithAlpha,
  RULER_HEIGHT_PX,
} from '@/components/arrangement/theme';
import {
  type AutomationLaneState,
  type AutomationParam,
  evaluateAutomationValue,
} from '@/project/automation';
import type { EditorTrack } from '@/project/types';
import {
  AUTOMATION_LANE_HEIGHT_PX,
  automationValueDomain,
  automationValueToY,
} from '@/ui/arrangement/automation-rows';
import type { AutomationInteractions } from '@/ui/arrangement/use-automation-interactions';
import type { TimelineRange } from '@/ui/canvas/timeline-range';

type ArrangementColors = typeof ARRANGEMENT_COLORS;

/** Px step between automation curve samples along the x axis. */
export const AUTOMATION_SAMPLE_STEP_PX = 2;

/** Radius of an automation breakpoint circle in px. */
export const AUTOMATION_POINT_RADIUS_PX = 3.5;

/** Alpha applied to a disabled lane's curve and breakpoints. */
export const AUTOMATION_DISABLED_ALPHA = 0.35;

/** Shared state the automation sublane drawing reads from the canvas. */
export interface AutomationSublaneContext {
  /** Timeline viewport. */
  range: TimelineRange;
  /** Tracks in lane order. */
  tracks: EditorTrack[];
  /** Ids of tracks whose automation sublane is expanded. */
  automationExpandedIds: readonly number[];
  /** Selected automation parameter per track id (absent = 'faderDb'). */
  automationParams: Record<number, AutomationParam>;
  /** Automation lanes from the store (sublane curve source). */
  automationLanes: readonly AutomationLaneState[];
  /** Automation sublane gesture state (preview and hover source). */
  automation: AutomationInteractions;
  /** Vertical scroll offset of the lane area in px. */
  scrollY: number;
  /** Resolves the content-px top of a row's automation sublane. */
  automationTop: (index: number) => number;
  /** Color tokens. */
  colors: ArrangementColors;
}

/**
 * Draws every expanded automation sublane: shade, curve and breakpoints.
 *
 * @param ctx - Target 2D context.
 * @param w - Canvas width in px.
 * @param h - Canvas height in px.
 * @param context - Shared rendering state.
 */
export function drawAutomationLanes(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  context: AutomationSublaneContext,
): void {
  const { tracks, automationExpandedIds, scrollY, automationTop } = context;
  const expanded = new Set(automationExpandedIds);
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (!expanded.has(track.id)) continue;
    const top = RULER_HEIGHT_PX + automationTop(i) - scrollY;
    const height = AUTOMATION_LANE_HEIGHT_PX;
    if (top + height <= RULER_HEIGHT_PX || top >= h) continue;
    drawAutomationSublane(ctx, w, track, top, height, context);
  }
}

/**
 * Draws one sublane: darker shade, mid-value line, curve and breakpoints.
 *
 * @param ctx - Target 2D context.
 * @param w - Canvas width in px.
 * @param track - Track owning the sublane.
 * @param top - Sublane top edge in viewport px.
 * @param height - Sublane height in px.
 * @param context - Shared rendering state.
 */
export function drawAutomationSublane(
  ctx: CanvasRenderingContext2D,
  w: number,
  track: EditorTrack,
  top: number,
  height: number,
  context: AutomationSublaneContext,
): void {
  const { range, automationParams, automationLanes, automation, colors } = context;
  const param = automationParams[track.id] ?? 'faderDb';
  ctx.save();
  ctx.beginPath();
  const clipTop = Math.max(top, RULER_HEIGHT_PX);
  ctx.rect(0, clipTop, w, top + height - clipTop);
  ctx.clip();
  ctx.fillStyle = colors.automationLane;
  ctx.fillRect(0, top, w, height);
  const domain = automationValueDomain(param);
  const midY = automationValueToY(param, (domain.min + domain.max) / 2, top, height);
  ctx.fillStyle = colors.automationMidline;
  ctx.fillRect(0, Math.round(midY), w, 1);

  const lane = automationLanes.find((l) => l.target === track.id && l.param === param) ?? null;
  const preview = automation.preview.value;
  const previewing = preview !== null && preview.trackId === track.id && preview.param === param;
  const points = previewing ? preview.points : (lane?.points ?? []);
  if (points.length === 0) {
    ctx.restore();
    return;
  }
  if (lane && !lane.enabled) ctx.globalAlpha = AUTOMATION_DISABLED_ALPHA;

  // Curve polyline: regular x samples plus the exact breakpoint vertices.
  const xs: number[] = [];
  for (let x = 0; x <= w; x += AUTOMATION_SAMPLE_STEP_PX) xs.push(x);
  for (const point of points) {
    const x = range.ppqToX(point.ppq);
    if (x > 0 && x < w) xs.push(x);
  }
  xs.sort((a, b) => a - b);
  ctx.strokeStyle = colorWithAlpha(track.color, 0.9);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < xs.length; i++) {
    const value = evaluateAutomationValue(points, range.xToPpq(xs[i]));
    const y = automationValueToY(param, value, top, height);
    if (i === 0) ctx.moveTo(xs[i], y);
    else ctx.lineTo(xs[i], y);
  }
  ctx.stroke();

  const hover = automation.hover.value;
  for (let i = 0; i < points.length; i++) {
    const x = range.ppqToX(points[i].ppq);
    if (x < -AUTOMATION_POINT_RADIUS_PX || x > w + AUTOMATION_POINT_RADIUS_PX) continue;
    const y = automationValueToY(param, points[i].value, top, height);
    const hovered =
      !previewing &&
      hover !== null &&
      hover.trackId === track.id &&
      hover.param === param &&
      hover.index === i;
    ctx.fillStyle = hovered ? colors.automationPointHover : track.color;
    ctx.beginPath();
    ctx.arc(x, y, AUTOMATION_POINT_RADIUS_PX, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
