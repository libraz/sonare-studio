<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TimeSignatureSegment } from '@/project/types';
import { observeDevicePixelRatio } from '@/ui/canvas/device-pixel-ratio';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { CANVAS_FONT_SIZE_PX, canvasFont } from '@/ui/theme/tokens';
import { getCanvasContext, PIANO_ROLL_COLORS, setupCanvas } from './theme';
import { localRulerTicks } from './timeline-meter';

const props = defineProps<{
  range: TimelineRange;
  revision: number;
  painter: Painter;
  clipLengthPpq: number;
  timeSignatures: TimeSignatureSegment[];
  timeSignatureOriginPpq?: number;
}>();

const emit = defineEmits<{
  /** Seek the transport to a clip-source PPQ position (press or scrub). */
  seek: [localPpq: number];
}>();

const wrapper = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);

let scrubbing = false;

/** Clip-source PPQ under a pointer event, clamped to the timeline origin. */
function ppqFromEvent(event: PointerEvent): number {
  const el = wrapper.value;
  if (!el) return 0;
  const x = event.clientX - el.getBoundingClientRect().left;
  return Math.max(0, props.range.xToPpq(x));
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  scrubbing = true;
  wrapper.value?.setPointerCapture(event.pointerId);
  emit('seek', ppqFromEvent(event));
}

function onPointerMove(event: PointerEvent): void {
  if (!scrubbing) return;
  emit('seek', ppqFromEvent(event));
}

function onPointerUp(event: PointerEvent): void {
  if (!scrubbing) return;
  scrubbing = false;
  wrapper.value?.releasePointerCapture(event.pointerId);
}

const layerId = Math.random().toString(36).slice(2, 8);
const COLORS = PIANO_ROLL_COLORS;

let widthPx = 0;
let heightPx = 0;
let resizeObserver: ResizeObserver | null = null;
let stopDprObserver: (() => void) | null = null;

function schedule(): void {
  props.painter.schedule(`piano-roll-ruler-${layerId}`, draw);
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

  ctx.fillStyle = COLORS.rulerBackground;
  ctx.fillRect(0, 0, widthPx, heightPx);

  ctx.font = canvasFont(CANVAS_FONT_SIZE_PX.meta);
  ctx.textBaseline = 'middle';

  for (const tick of localRulerTicks(
    props.timeSignatures,
    props.timeSignatureOriginPpq ?? 0,
    props.range.startPpq,
    props.range.endPpq,
    props.range.pxPerPpq,
  )) {
    const x = Math.round(props.range.ppqToX(tick.ppq)) + 0.5;
    ctx.strokeStyle = tick.kind === 'bar' ? COLORS.rulerBar : COLORS.rulerBeat;
    ctx.beginPath();
    ctx.moveTo(x, tick.kind === 'bar' ? 0 : heightPx * 0.5);
    ctx.lineTo(x, heightPx);
    ctx.stroke();

    if (tick.label) {
      ctx.fillStyle = COLORS.rulerText;
      ctx.fillText(tick.label, x + 4, heightPx * 0.48);
    }
  }

  const clipEndX = props.range.ppqToX(props.clipLengthPpq);
  if (clipEndX < widthPx) {
    ctx.fillStyle = COLORS.beyondClip;
    ctx.fillRect(Math.max(0, clipEndX), 0, widthPx - Math.max(0, clipEndX), heightPx);
  }
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
  () =>
    [
      props.revision,
      props.clipLengthPpq,
      props.timeSignatures,
      props.timeSignatureOriginPpq,
    ] as const,
  () => schedule(),
);
</script>

<template>
  <div
    ref="wrapper"
    class="piano-roll-ruler"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <canvas ref="canvas" class="piano-roll-ruler__canvas" aria-hidden="true" />
  </div>
</template>

<style scoped>
.piano-roll-ruler {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border-strong);
  cursor: pointer;
  touch-action: none;
}

.piano-roll-ruler__canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}
</style>
