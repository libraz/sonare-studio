<script setup lang="ts">
import { ref, watch } from 'vue';
import type { TimeSignatureSegment } from '@/project/types';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { createLayerId, useCanvasSurface } from '@/ui/canvas/use-canvas-surface';
import { CANVAS_FONT_SIZE_PX, canvasFont } from '@/ui/theme/tokens';
import { getCanvasContext, PIANO_ROLL_COLORS } from './theme';
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

const layerId = createLayerId();
const COLORS = PIANO_ROLL_COLORS;

const surface = useCanvasSurface({
  container: wrapper,
  canvases: () => [canvas.value],
  redraw: schedule,
});
function schedule(): void {
  props.painter.schedule(`piano-roll-ruler-${layerId}`, draw);
}

function draw(): void {
  const el = canvas.value;
  if (!el || surface.widthPx <= 0 || surface.heightPx <= 0) return;
  const ctx = getCanvasContext(el);
  if (!ctx) return;

  ctx.fillStyle = COLORS.rulerBackground;
  ctx.fillRect(0, 0, surface.widthPx, surface.heightPx);

  ctx.font = canvasFont(CANVAS_FONT_SIZE_PX.meta);
  ctx.textBaseline = 'middle';

  const ticks = localRulerTicks(
    props.timeSignatures,
    props.timeSignatureOriginPpq ?? 0,
    props.range.startPpq,
    props.range.endPpq,
    props.range.pxPerPpq,
  );
  const tickX = (ppq: number): number => Math.round(props.range.ppqToX(ppq)) + 0.5;

  // One path and one stroke per tick kind.
  for (const kind of ['beat', 'bar'] as const) {
    ctx.strokeStyle = kind === 'bar' ? COLORS.rulerBar : COLORS.rulerBeat;
    ctx.beginPath();
    for (const tick of ticks) {
      if (tick.kind !== kind) continue;
      const x = tickX(tick.ppq);
      ctx.moveTo(x, kind === 'bar' ? 0 : surface.heightPx * 0.5);
      ctx.lineTo(x, surface.heightPx);
    }
    ctx.stroke();
  }

  ctx.fillStyle = COLORS.rulerText;
  for (const tick of ticks) {
    if (tick.label) ctx.fillText(tick.label, tickX(tick.ppq) + 4, surface.heightPx * 0.48);
  }

  const clipEndX = props.range.ppqToX(props.clipLengthPpq);
  if (clipEndX < surface.widthPx) {
    ctx.fillStyle = COLORS.beyondClip;
    ctx.fillRect(
      Math.max(0, clipEndX),
      0,
      surface.widthPx - Math.max(0, clipEndX),
      surface.heightPx,
    );
  }
}

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
