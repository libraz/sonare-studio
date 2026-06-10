<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { setSelection, updateNotes } from '@/project/commands';
import type { EditorNote } from '@/project/types';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import {
  DEFAULT_NOTE_COLOR,
  getCanvasContext,
  type NoteColorFn,
  PIANO_ROLL_COLORS,
  setupCanvas,
} from './theme';

/**
 * Velocity lane below the note grid: one draggable bar per note, horizontally
 * aligned with the grid through the shared TimelineRange. Dragging a bar sets
 * the velocity of the grabbed note (and of the whole selection when the
 * grabbed note is selected); the edit commits as one undo step on release.
 */

const props = defineProps<{
  /** Shared timeline viewport (horizontal mapping only). */
  range: TimelineRange;
  /** Monotonic counter bumped by the container after view mutations. */
  revision: number;
  /** Shared frame batcher for canvas redraws. */
  painter: Painter;
  /** Notes whose velocities are shown. */
  notes: EditorNote[];
  /** Selected note ids. */
  selection: Set<number>;
  /** Per-note color resolver (single track color by default). */
  noteColor?: NoteColorFn;
}>();

const wrapper = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);

/** Unique painter layer suffix so several editors can share one painter. */
const layerId = Math.random().toString(36).slice(2, 8);

const COLORS = PIANO_ROLL_COLORS;

/** In-flight velocity overrides per note id while a drag runs. */
const preview = shallowRef<Map<number, number> | null>(null);

let widthPx = 0;
let heightPx = 0;
let dragTargets: number[] | null = null;

function schedule(): void {
  props.painter.schedule(`velocity-lane-${layerId}`, draw);
}

/** Computes the x extent of a note's velocity bar in viewport px. */
function barGeometry(note: EditorNote): { x: number; w: number } {
  const x = props.range.ppqToX(note.startPpq);
  const endX = props.range.ppqToX(note.startPpq + note.durationPpq);
  return { x, w: Math.max(3, Math.min(8, endX - x - 1)) };
}

/** Maps a lane-local y coordinate to a velocity (1..127, top = 127). */
function velocityFromY(y: number): number {
  if (heightPx <= 0) return 1;
  return Math.min(127, Math.max(1, Math.round((1 - y / heightPx) * 127)));
}

function draw(): void {
  const el = canvas.value;
  if (!el || widthPx <= 0 || heightPx <= 0) return;
  const ctx = getCanvasContext(el);
  if (!ctx) return;
  const range = props.range;

  ctx.fillStyle = COLORS.laneBackground;
  ctx.fillRect(0, 0, widthPx, heightPx);
  ctx.fillStyle = COLORS.laneRule;
  for (const fraction of [0.25, 0.5, 0.75]) {
    ctx.fillRect(0, Math.round(heightPx * fraction), widthPx, 1);
  }

  const colorOf = props.noteColor ?? ((): string => DEFAULT_NOTE_COLOR);
  const overrides = preview.value;
  for (const note of props.notes) {
    if (note.startPpq + note.durationPpq <= range.startPpq || note.startPpq >= range.endPpq) {
      continue;
    }
    const { x, w } = barGeometry(note);
    if (x + w < 0 || x > widthPx) continue;
    const velocity = overrides?.get(note.id) ?? note.velocity;
    const barH = Math.max(2, (velocity / 127) * (heightPx - 2));
    const selected = props.selection.has(note.id);
    ctx.globalAlpha = selected ? 1 : 0.7;
    ctx.fillStyle = colorOf(note);
    ctx.fillRect(x, heightPx - barH, w, barH);
    if (selected) {
      ctx.fillStyle = COLORS.noteSelectedBorder;
      ctx.fillRect(x, heightPx - barH, w, 2);
    }
  }
  ctx.globalAlpha = 1;
}

/** Finds the topmost note whose bar column contains the x coordinate. */
function hitBar(x: number): EditorNote | null {
  for (let i = props.notes.length - 1; i >= 0; i--) {
    const note = props.notes[i];
    const { x: barX, w } = barGeometry(note);
    if (x >= barX && x <= barX + w) return note;
  }
  return null;
}

function localPoint(event: PointerEvent): { x: number; y: number } {
  const rect = wrapper.value?.getBoundingClientRect();
  return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  const point = localPoint(event);
  const hit = hitBar(point.x);
  if (!hit) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  if (props.selection.has(hit.id)) {
    dragTargets = [...props.selection];
  } else {
    dragTargets = [hit.id];
    setSelection([hit.id]);
  }
  const velocity = velocityFromY(point.y);
  preview.value = new Map(dragTargets.map((id) => [id, velocity]));
  schedule();
}

function onPointerMove(event: PointerEvent): void {
  if (!dragTargets) return;
  const velocity = velocityFromY(localPoint(event).y);
  preview.value = new Map(dragTargets.map((id) => [id, velocity]));
  schedule();
}

function onPointerUp(): void {
  if (!dragTargets) return;
  const overrides = preview.value;
  const targets = dragTargets;
  dragTargets = null;
  preview.value = null;
  if (overrides) {
    const byId = new Map(props.notes.map((note) => [note.id, note]));
    const updates = targets.flatMap((id) => {
      const velocity = overrides.get(id);
      const note = byId.get(id);
      return velocity !== undefined && note && note.velocity !== velocity ? [{ id, velocity }] : [];
    });
    if (updates.length > 0) updateNotes(updates);
  }
  schedule();
}

function onPointerCancel(): void {
  dragTargets = null;
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
  () => [props.revision, props.notes, props.selection] as const,
  () => schedule(),
);
</script>

<template>
  <div
    ref="wrapper"
    class="velocity-lane"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
  >
    <canvas ref="canvas" class="velocity-canvas" />
  </div>
</template>

<style scoped>
.velocity-lane {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: none;
  cursor: ns-resize;
}

.velocity-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
</style>
