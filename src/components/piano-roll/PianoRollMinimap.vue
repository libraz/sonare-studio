<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { EditorNote } from '@/project/types';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { getCanvasContext, PIANO_ROLL_COLORS, setupCanvas } from './theme';

const props = defineProps<{
  range: TimelineRange;
  revision: number;
  painter: Painter;
  notes: EditorNote[];
  clipLengthPpq: number;
}>();

const emit = defineEmits<{
  scrollTo: [centerPpq: number];
}>();

const wrapper = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);

const layerId = Math.random().toString(36).slice(2, 8);
const COLORS = PIANO_ROLL_COLORS;

let widthPx = 0;
let heightPx = 0;
let resizeObserver: ResizeObserver | null = null;

function contentEndPpq(): number {
  const noteEnd = props.notes.reduce(
    (end, note) => Math.max(end, note.startPpq + note.durationPpq),
    0,
  );
  return Math.max(1, props.clipLengthPpq, noteEnd, props.range.endPpq);
}

function xForPpq(ppq: number): number {
  return (ppq / contentEndPpq()) * widthPx;
}

function yForPitch(pitch: number): number {
  return ((127 - pitch) / 127) * heightPx;
}

function schedule(): void {
  props.painter.schedule(`piano-roll-minimap-${layerId}`, draw);
}

function draw(): void {
  const el = canvas.value;
  if (!el || widthPx <= 0 || heightPx <= 0) return;
  const ctx = getCanvasContext(el);
  if (!ctx) return;
  ctx.fillStyle = COLORS.minimapBackground;
  ctx.fillRect(0, 0, widthPx, heightPx);

  ctx.fillStyle = COLORS.minimapNote;
  for (const note of props.notes) {
    const x = xForPpq(note.startPpq);
    const w = Math.max(1, xForPpq(note.startPpq + note.durationPpq) - x);
    const y = yForPitch(note.pitch);
    ctx.fillRect(x, y, w, 2);
  }

  const viewX = xForPpq(props.range.startPpq);
  const viewW = Math.max(6, xForPpq(props.range.endPpq) - viewX);
  ctx.fillStyle = COLORS.minimapViewportFill;
  ctx.fillRect(viewX, 0, viewW, heightPx);
  ctx.strokeStyle = COLORS.minimapViewportStroke;
  ctx.strokeRect(viewX + 0.5, 0.5, Math.max(1, viewW - 1), Math.max(1, heightPx - 1));
}

function localX(event: PointerEvent): number {
  const rect = wrapper.value?.getBoundingClientRect();
  return event.clientX - (rect?.left ?? 0);
}

function onPointer(event: PointerEvent): void {
  if (event.button !== 0 && event.type === 'pointerdown') return;
  const ppq =
    (Math.max(0, Math.min(widthPx, localX(event))) / Math.max(1, widthPx)) * contentEndPpq();
  emit('scrollTo', ppq);
}

function onPointerMove(event: PointerEvent): void {
  if ((event.buttons & 1) === 0) return;
  onPointer(event);
}

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
});

watch(
  () => [props.revision, props.notes, props.clipLengthPpq] as const,
  () => schedule(),
);
</script>

<template>
  <div
    ref="wrapper"
    class="piano-roll-minimap"
    @pointerdown="onPointer"
    @pointermove="onPointerMove"
  >
    <canvas ref="canvas" class="piano-roll-minimap__canvas" aria-hidden="true" />
  </div>
</template>

<style scoped>
.piano-roll-minimap {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  cursor: pointer;
  touch-action: none;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border-strong);
}

.piano-roll-minimap__canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}
</style>
