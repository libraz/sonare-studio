<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { setClipCcLane } from '@/project/commands';
import type { ClipCcPoint } from '@/project/types';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { useI18n } from '@/ui/i18n';
import { DEFAULT_NOTE_COLOR, getCanvasContext, PIANO_ROLL_COLORS, setupCanvas } from './theme';

/**
 * Continuous-controller (CC) lane below the note grid: a stepped curve of the
 * active clip's breakpoints for one controller, sharing the grid's horizontal
 * TimelineRange. The value axis is 0-127 (bottom to top). Drag a breakpoint to
 * move it, click empty space to add one, drag across empty space to draw a
 * freehand curve, and alt-click or right-click a breakpoint to delete it. Each
 * gesture commits as one undo step via setClipCcLane; the points feed the
 * realtime MIDI schedule (src/engine/midi-sync.ts), so the curve is audible.
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
  /** Controller number this lane edits (0-127). */
  controller: number;
  /** MIDI channel the CC is emitted on (0-15). */
  channel: number;
  /** Breakpoints of the active controller, sorted by ppq. */
  points: ClipCcPoint[];
  /** Curve color; defaults to the neutral note color. */
  color?: string;
  /** Optional horizontal snap applied to added/moved points. */
  snapPpq?: (ppq: number) => number;
}>();

const { t } = useI18n();

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
  return Math.min(127, Math.max(0, Math.round((1 - y / heightPx) * 127)));
}

function yFromValue(value: number): number {
  return (1 - value / 127) * heightPx;
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

  const color = props.color ?? DEFAULT_NOTE_COLOR;
  const pts = [...currentPoints()].sort((a, b) => a.ppq - b.ppq);
  if (pts.length > 0) {
    // Stepped curve: the value holds until the next breakpoint, matching the
    // discrete CC events the engine receives. Trailing segment runs to the edge.
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let prevY = yFromValue(pts[0].value);
    ctx.moveTo(0, prevY);
    for (const point of pts) {
      const x = props.range.ppqToX(point.ppq);
      const y = yFromValue(point.value);
      ctx.lineTo(x, prevY);
      ctx.lineTo(x, y);
      prevY = y;
    }
    ctx.lineTo(widthPx, prevY);
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
    ctx.fillText(`CC${props.controller}: ${dragValue}`, 6, 12);
  }
}

/** Draw step: replaces breakpoints near the new position, then adds it. */
function applyDraw(ppq: number, value: number): void {
  const windowPpq = DRAW_MIN_PX / Math.max(1e-6, props.range.pxPerPpq);
  const next = (preview.value ?? props.points).filter((p) => Math.abs(p.ppq - ppq) >= windowPpq);
  next.push({ ppq, value });
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
      setClipCcLane(props.clipId, props.controller, props.channel, next);
    }
    return;
  }
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);

  if (hit >= 0) {
    const ppq = ppqFromX(point.x);
    const working = props.points.map((p) => ({ ...p }));
    working[hit] = { ppq, value };
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
    working[drag.index] = { ppq, value };
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
  return sa.every((p, i) => p.ppq === sb[i].ppq && p.value === sb[i].value);
}

function onPointerUp(): void {
  if (!drag) return;
  const result = preview.value;
  drag = null;
  dragValue = null;
  preview.value = null;
  if (result && !pointsEqual(result, props.points)) {
    setClipCcLane(props.clipId, props.controller, props.channel, result);
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
  () => [props.revision, props.points, props.controller, props.clipId] as const,
  () => schedule(),
);
</script>

<template>
  <div
    ref="wrapper"
    class="cc-lane"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @contextmenu.prevent
  >
    <canvas ref="canvas" class="cc-canvas" role="img" :aria-label="t.shell.pianoRoll.ccLane" />
  </div>
</template>

<style scoped>
.cc-lane {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: none;
  cursor: crosshair;
}

.cc-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
</style>
