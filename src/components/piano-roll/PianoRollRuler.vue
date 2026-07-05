<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TimeSignatureSegment } from '@/project/types';
import { localizeMeter, rulerTicks } from '@/ui/arrangement/ruler';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { getCanvasContext, PIANO_ROLL_COLORS, setupCanvas } from './theme';

const props = defineProps<{
  range: TimelineRange;
  revision: number;
  painter: Painter;
  clipLengthPpq: number;
  timeSignatures: TimeSignatureSegment[];
  timeSignatureOriginPpq?: number;
}>();

const wrapper = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);

const layerId = Math.random().toString(36).slice(2, 8);
const COLORS = PIANO_ROLL_COLORS;
const localTimeSignatures = computed(() =>
  localizeMeter(props.timeSignatures, props.timeSignatureOriginPpq ?? 0),
);

let widthPx = 0;
let heightPx = 0;
let resizeObserver: ResizeObserver | null = null;

function schedule(): void {
  props.painter.schedule(`piano-roll-ruler-${layerId}`, draw);
}

function draw(): void {
  const el = canvas.value;
  if (!el || widthPx <= 0 || heightPx <= 0) return;
  const ctx = getCanvasContext(el);
  if (!ctx) return;

  ctx.fillStyle = COLORS.rulerBackground;
  ctx.fillRect(0, 0, widthPx, heightPx);

  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  for (const tick of rulerTicks(
    localTimeSignatures.value,
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
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
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
  <div ref="wrapper" class="piano-roll-ruler">
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
}

.piano-roll-ruler__canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}
</style>
