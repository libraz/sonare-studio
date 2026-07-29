<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { EditorNote } from '@/project/types';
import { observeDevicePixelRatio } from '@/ui/canvas/device-pixel-ratio';
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
let stopDprObserver: (() => void) | null = null;

function contentEndPpq(): number {
  const noteEnd = props.notes.reduce(
    (end, note) => Math.max(end, note.startPpq + note.durationPpq),
    0,
  );
  // The viewport is deliberately excluded: scrolling it while dragging this
  // minimap must not alter the time-to-x scale beneath the pointer.
  return Math.max(1, props.clipLengthPpq, noteEnd);
}

function yForPitch(pitch: number): number {
  return ((127 - pitch) / 127) * heightPx;
}

function schedule(): void {
  props.painter.schedule(`piano-roll-minimap-${layerId}`, draw);
}

function refreshForDevicePixelRatio(): void {
  if (widthPx <= 0 || heightPx <= 0) return;
  if (canvas.value) setupCanvas(canvas.value, widthPx, heightPx);
  schedule();
}

function draw(): void {
  const el = canvas.value;
  if (!el || widthPx <= 0 || heightPx <= 0) return;
  const ctx = getCanvasContext(el);
  if (!ctx) return;
  ctx.fillStyle = COLORS.minimapBackground;
  ctx.fillRect(0, 0, widthPx, heightPx);

  // Resolve the time-to-x scale once: contentEndPpq() reduces over every note,
  // so calling it per note (twice) made draw() O(notes^2) and dominated the
  // playback frame on dense clips.
  const scaleX = widthPx / contentEndPpq();

  ctx.fillStyle = COLORS.minimapNote;
  for (const note of props.notes) {
    const x = note.startPpq * scaleX;
    const w = Math.max(1, note.durationPpq * scaleX);
    const y = yForPitch(note.pitch);
    ctx.fillRect(x, y, w, 2);
  }

  const viewX = props.range.startPpq * scaleX;
  const viewW = Math.max(6, (props.range.endPpq - props.range.startPpq) * scaleX);
  ctx.fillStyle = COLORS.minimapViewportFill;
  ctx.fillRect(viewX, 0, viewW, heightPx);
  ctx.strokeStyle = COLORS.minimapViewportStroke;
  ctx.strokeRect(viewX + 0.5, 0.5, Math.max(1, viewW - 1), Math.max(1, heightPx - 1));
}

function localX(event: PointerEvent): number {
  const rect = wrapper.value?.getBoundingClientRect();
  return event.clientX - (rect?.left ?? 0);
}

function scrollToPointer(event: PointerEvent): void {
  const ppq =
    (Math.max(0, Math.min(widthPx, localX(event))) / Math.max(1, widthPx)) * contentEndPpq();
  emit('scrollTo', ppq);
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  scrollToPointer(event);
}

function onPointerMove(event: PointerEvent): void {
  if ((event.buttons & 1) === 0) return;
  scrollToPointer(event);
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
  stopDprObserver = observeDevicePixelRatio(refreshForDevicePixelRatio);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  stopDprObserver?.();
  stopDprObserver = null;
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
    @pointerdown="onPointerDown"
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
