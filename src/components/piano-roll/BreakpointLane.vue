<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { isClipExpressionCurve } from '@/project/midi-cc';
import type { ClipCcPoint, ClipExpressionCurve } from '@/project/types';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { useI18n } from '@/ui/i18n';
import { DEFAULT_NOTE_COLOR, getCanvasContext, PIANO_ROLL_COLORS, setupCanvas } from './theme';

/**
 * Generic breakpoint-automation lane below the note grid: a curve of a
 * clip's {ppq, value} breakpoints sharing the grid's horizontal TimelineRange.
 * The value axis runs 0..`valueMax` (bottom to top). Drag a breakpoint to move
 * it, click empty space to add one, drag across empty space to draw a freehand
 * curve, and alt-click or right-click a breakpoint to delete it. Each gesture
 * commits as one undo step via the `commit` callback; the host wires it to the
 * matching command (CC, pitch bend, ...) and the points feed the realtime MIDI
 * schedule (src/engine/midi-sync.ts), so the curve is audible.
 *
 * When `centerValue` is set, a center rule is drawn and the corner readout
 * shows the signed offset from it (used by bipolar lanes like pitch bend).
 */

const props = defineProps<{
  /** Shared timeline viewport (horizontal mapping only). */
  range: TimelineRange;
  /** Monotonic counter bumped by the container after view mutations. */
  revision: number;
  /** Shared frame batcher for canvas redraws. */
  painter: Painter;
  /** Active clip id the lane edits. */
  clipId: number;
  /** Clip window length in PPQ (positions clamp to it). */
  clipLengthPpq: number;
  /** Breakpoints of the active lane, sorted by ppq. */
  points: ClipCcPoint[];
  /** Commits an edited point list as one undoable step. */
  commit: (points: ClipCcPoint[]) => void;
  /** Top of the value axis (default 127 = 7-bit). */
  valueMax?: number;
  /** When set, draws a center rule and shows a signed readout offset from it. */
  centerValue?: number;
  /** Readout prefix shown during a gesture (e.g. "CC1", "Bend"); '' = value only. */
  readoutLabel?: string;
  /** Accessible name for the lane canvas. */
  ariaLabel?: string;
  /** Curve color; defaults to the neutral note color. */
  color?: string;
  /** Optional horizontal snap applied to added/moved points. */
  snapPpq?: (ppq: number) => number;
  /** Curve assigned to newly drawn breakpoints; existing moved points preserve theirs. */
  curveMode?: ClipExpressionCurve;
}>();

const { t } = useI18n();

/** Top of the value axis (7-bit by default). */
function maxValue(): number {
  return props.valueMax ?? 127;
}

const wrapper = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);

/** Unique painter layer suffix so several editors can share one painter. */
const layerId = Math.random().toString(36).slice(2, 8);

const COLORS = PIANO_ROLL_COLORS;

/** Hit radius in CSS px for grabbing or deleting a breakpoint. */
const HIT_RADIUS = 7;
/** Minimum horizontal px between samples while drawing a freehand curve. */
const DRAW_MIN_PX = 6;

/** In-flight working copy of the points while a gesture runs. */
const preview = shallowRef<ClipCcPoint[] | null>(null);

let widthPx = 0;
let heightPx = 0;

/** Active gesture: moving one breakpoint, or drawing a freehand curve. */
type DragState = { mode: 'move'; index: number } | { mode: 'draw' };

let drag: DragState | null = null;
/** Last pointer value of the running gesture, for the corner readout. */
let dragValue: number | null = null;

function schedule(): void {
  props.painter.schedule(`cc-lane-${layerId}`, draw);
}

/** Points currently shown (gesture preview if active, else the props list). */
function currentPoints(): ClipCcPoint[] {
  return preview.value ?? props.points;
}

function valueFromY(y: number): number {
  if (heightPx <= 0) return 0;
  const max = maxValue();
  return Math.min(max, Math.max(0, Math.round((1 - y / heightPx) * max)));
}

function yFromValue(value: number): number {
  return (1 - value / maxValue()) * heightPx;
}

function effectiveCurve(point: ClipCcPoint): ClipExpressionCurve {
  return isClipExpressionCurve(point.curve) ? point.curve : 'hold';
}

function pointWithCurve(ppq: number, value: number, curve = props.curveMode): ClipCcPoint {
  return curve && curve !== 'hold' ? { ppq, value, curve } : { ppq, value };
}

function segmentValue(start: number, end: number, t: number, curve: ClipExpressionCurve): number {
  if (curve === 's-curve') {
    const eased = t * t * (3 - 2 * t);
    return start + (end - start) * eased;
  }
  return start + (end - start) * t;
}

function ppqFromX(x: number): number {
  const raw = Math.min(props.clipLengthPpq, Math.max(0, props.range.xToPpq(x)));
  return props.snapPpq ? Math.min(props.clipLengthPpq, Math.max(0, props.snapPpq(raw))) : raw;
}

function localPoint(event: PointerEvent): { x: number; y: number } {
  const rect = wrapper.value?.getBoundingClientRect();
  return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
}

/** Index of the breakpoint within HIT_RADIUS of (x, y), or -1. */
function hitPoint(x: number, y: number): number {
  const pts = currentPoints();
  let best = -1;
  let bestDist = HIT_RADIUS * HIT_RADIUS;
  for (let i = 0; i < pts.length; i++) {
    const px = props.range.ppqToX(pts[i].ppq);
    const py = yFromValue(pts[i].value);
    const dist = (px - x) ** 2 + (py - y) ** 2;
    if (dist <= bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

function draw(): void {
  const el = canvas.value;
  if (!el || widthPx <= 0 || heightPx <= 0) return;
  const ctx = getCanvasContext(el);
  if (!ctx) return;

  ctx.fillStyle = COLORS.laneBackground;
  ctx.fillRect(0, 0, widthPx, heightPx);
  ctx.fillStyle = COLORS.laneRule;
  for (const fraction of [0.25, 0.5, 0.75]) {
    ctx.fillRect(0, Math.round(heightPx * fraction), widthPx, 1);
  }
  // Bipolar lanes (pitch bend) get a brighter center rule at the no-bend value.
  if (props.centerValue !== undefined) {
    ctx.fillStyle = COLORS.laneValueText;
    ctx.fillRect(0, Math.round(yFromValue(props.centerValue)), widthPx, 1);
  }

  const color = props.color ?? DEFAULT_NOTE_COLOR;
  const pts = [...currentPoints()].sort((a, b) => a.ppq - b.ppq);
  if (pts.length > 0) {
    // Each breakpoint owns the curve to the next point. Hold preserves old
    // projects; ramp modes are sampled visually to match playback/export.
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const firstY = yFromValue(pts[0].value);
    ctx.moveTo(0, firstY);
    ctx.lineTo(props.range.ppqToX(pts[0].ppq), firstY);
    for (let i = 0; i < pts.length - 1; i++) {
      const point = pts[i];
      const next = pts[i + 1];
      const curve = effectiveCurve(point);
      const startX = props.range.ppqToX(point.ppq);
      const endX = props.range.ppqToX(next.ppq);
      const startY = yFromValue(point.value);
      const endY = yFromValue(next.value);
      if (curve === 'hold') {
        ctx.lineTo(endX, startY);
        ctx.lineTo(endX, endY);
      } else if (curve === 'linear') {
        ctx.lineTo(startX, startY);
        ctx.lineTo(endX, endY);
      } else {
        const samples = Math.max(4, Math.min(48, Math.ceil(Math.abs(endX - startX) / 8)));
        for (let step = 1; step <= samples; step++) {
          const t = step / samples;
          ctx.lineTo(
            startX + (endX - startX) * t,
            yFromValue(segmentValue(point.value, next.value, t, curve)),
          );
        }
      }
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(widthPx, yFromValue(last.value));
    ctx.stroke();

    ctx.fillStyle = color;
    for (const point of pts) {
      const x = props.range.ppqToX(point.ppq);
      if (x < -3 || x > widthPx + 3) continue;
      const y = yFromValue(point.value);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (dragValue !== null) {
    ctx.fillStyle = COLORS.laneValueText;
    ctx.font = '10px system-ui, sans-serif';
    const prefix = props.readoutLabel ? `${props.readoutLabel}: ` : '';
    let shown = `${dragValue}`;
    if (props.centerValue !== undefined) {
      const signed = dragValue - props.centerValue;
      shown = `${signed > 0 ? '+' : ''}${signed}`;
    }
    ctx.fillText(`${prefix}${shown}`, 6, 12);
  }
}

/** Draw step: replaces breakpoints near the new position, then adds it. */
function applyDraw(ppq: number, value: number): void {
  const windowPpq = DRAW_MIN_PX / Math.max(1e-6, props.range.pxPerPpq);
  const next = (preview.value ?? props.points).filter((p) => Math.abs(p.ppq - ppq) >= windowPpq);
  next.push(pointWithCurve(ppq, value));
  preview.value = next;
}

function onPointerDown(event: PointerEvent): void {
  if (props.clipId < 0) return;
  const point = localPoint(event);
  const value = valueFromY(point.y);
  const hit = hitPoint(point.x, point.y);

  // Alt-click or right-click a breakpoint deletes it (one undo step).
  if (event.button === 2 || event.altKey) {
    if (hit >= 0) {
      event.preventDefault();
      const next = props.points.filter((_, i) => i !== hit);
      props.commit(next);
    }
    return;
  }
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);

  if (hit >= 0) {
    const ppq = ppqFromX(point.x);
    const working = props.points.map((p) => ({ ...p }));
    working[hit] = pointWithCurve(ppq, value, working[hit].curve);
    preview.value = working;
    drag = { mode: 'move', index: hit };
  } else {
    drag = { mode: 'draw' };
    applyDraw(ppqFromX(point.x), value);
  }
  dragValue = value;
  schedule();
}

function onPointerMove(event: PointerEvent): void {
  if (!drag) return;
  const point = localPoint(event);
  const value = valueFromY(point.y);
  const ppq = ppqFromX(point.x);
  if (drag.mode === 'move') {
    const working = (preview.value ?? props.points).map((p) => ({ ...p }));
    working[drag.index] = pointWithCurve(ppq, value, working[drag.index].curve);
    preview.value = working;
  } else {
    applyDraw(ppq, value);
  }
  dragValue = value;
  schedule();
}

/** True when two point lists are identical (avoids no-op undo entries). */
function pointsEqual(a: ReadonlyArray<ClipCcPoint>, b: ReadonlyArray<ClipCcPoint>): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((p, q) => p.ppq - q.ppq);
  const sb = [...b].sort((p, q) => p.ppq - q.ppq);
  return sa.every(
    (p, i) =>
      p.ppq === sb[i].ppq && p.value === sb[i].value && effectiveCurve(p) === effectiveCurve(sb[i]),
  );
}

function onPointerUp(): void {
  if (!drag) return;
  const result = preview.value;
  drag = null;
  dragValue = null;
  preview.value = null;
  if (result && !pointsEqual(result, props.points)) {
    props.commit(result);
  }
  schedule();
}

function onPointerCancel(): void {
  drag = null;
  dragValue = null;
  preview.value = null;
  schedule();
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  const el = wrapper.value;
  if (!el) return;
  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    widthPx = entry.contentRect.width;
    heightPx = entry.contentRect.height;
    if (widthPx <= 0 || heightPx <= 0) return;
    if (canvas.value) setupCanvas(canvas.value, widthPx, heightPx);
    schedule();
  });
  resizeObserver.observe(el);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

watch(
  () => [props.revision, props.points, props.clipId, props.valueMax, props.curveMode] as const,
  () => schedule(),
);
</script>

<template>
  <div
    ref="wrapper"
    class="breakpoint-lane"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @contextmenu.prevent
  >
    <canvas
      ref="canvas"
      class="breakpoint-canvas"
      role="img"
      :aria-label="props.ariaLabel ?? t.shell.pianoRoll.ccLane"
    />
  </div>
</template>

<style scoped>
.breakpoint-lane {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: none;
  cursor: crosshair;
}

.breakpoint-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
</style>
