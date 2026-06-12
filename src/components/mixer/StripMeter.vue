<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { MeterSource } from '@/engine/meters';
import {
  advanceMeterChannel,
  createMeterChannel,
  isMeterAtFloor,
  METER_MIN_DB,
  type MeterChannelModel,
  meterFraction,
  resetMeterClip,
} from '@/ui/mixer/meter-model';

/**
 * Compact per-strip stereo meter: peak + RMS bars with a latched clip LED
 * (click to reset). Any meter source works (master, track lane, bus); strips
 * without a live source render the placeholder variant.
 */

const props = withDefaults(
  defineProps<{
    /** Live level source; null draws a silent meter. */
    bridge?: MeterSource | null;
    /** Placeholder mode: static dimmed bars, no animation, no clip LED. */
    placeholder?: boolean;
    /** Bar area width in CSS px. */
    width?: number;
    /** Total height in CSS px (clip LED + bars). */
    height?: number;
    /** Bottom of the visible dB range. */
    minDb?: number;
  }>(),
  { bridge: null, placeholder: false, width: 12, height: 132, minDb: METER_MIN_DB },
);

/** Height of the clip LED row at the top, in px. */
const CLIP_LED_H = 7;

const GREEN_BELOW_DB = -12;
const YELLOW_BELOW_DB = -6;

const canvasRef = ref<HTMLCanvasElement | null>(null);
let rafId = 0;
let lastTs = 0;
/** True once the floor state was painted; idle frames are then skipped. */
let idleFrameDrawn = false;
const channels: MeterChannelModel[] = [
  createMeterChannel(props.minDb),
  createMeterChannel(props.minDb),
];

const clipped = ref(false);

const title = computed(() =>
  props.placeholder
    ? 'No live meter for this strip'
    : clipped.value
      ? 'Clipped - click to reset'
      : 'Stereo level meter',
);

function resizeCanvas(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(props.width * dpr);
  canvas.height = Math.round(props.height * dpr);
  canvas.style.width = `${props.width}px`;
  canvas.style.height = `${props.height}px`;
  // Resizing clears the backing store, so the next frame must repaint.
  idleFrameDrawn = false;
}

/** dB to y inside the bar area (below the clip LED). */
function dbToY(db: number, barsH: number): number {
  return CLIP_LED_H + (1 - meterFraction(db, props.minDb)) * barsH;
}

function drawBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  barW: number,
  barsH: number,
  model: MeterChannelModel,
): void {
  const bottom = CLIP_LED_H + barsH;
  const yYellow = dbToY(GREEN_BELOW_DB, barsH);
  const yRed = dbToY(YELLOW_BELOW_DB, barsH);
  // Dim zone backdrop.
  ctx.fillStyle = '#0c2012';
  ctx.fillRect(x, yYellow, barW, bottom - yYellow);
  ctx.fillStyle = '#221f0a';
  ctx.fillRect(x, yRed, barW, yYellow - yRed);
  ctx.fillStyle = '#220c0c';
  ctx.fillRect(x, CLIP_LED_H, barW, yRed - CLIP_LED_H);
  // RMS fill per zone.
  const yRms = dbToY(model.rmsDb, barsH);
  const fillZone = (color: string, zoneTop: number, zoneBottom: number): void => {
    const top = Math.max(yRms, zoneTop);
    if (top < zoneBottom) {
      ctx.fillStyle = color;
      ctx.fillRect(x, top, barW, zoneBottom - top);
    }
  };
  fillZone('#22c55e', yYellow, bottom);
  fillZone('#eab308', yRed, yYellow);
  fillZone('#ef4444', CLIP_LED_H, yRed);
  // Peak cap.
  if (model.peakDb > props.minDb) {
    const yPeak = dbToY(model.peakDb, barsH);
    ctx.fillStyle = model.peakDb >= YELLOW_BELOW_DB ? '#f87171' : '#cbd5e1';
    ctx.fillRect(x, Math.max(CLIP_LED_H, yPeak - 1), barW, 1.5);
  }
  // Peak-hold marker.
  if (model.holdDb > props.minDb) {
    const yHold = dbToY(model.holdDb, barsH);
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(x, Math.max(CLIP_LED_H, yHold - 0.5), barW, 1);
  }
}

function drawFrame(ctx: CanvasRenderingContext2D): void {
  const w = props.width;
  const h = props.height;
  const barsH = h - CLIP_LED_H - 1;
  ctx.fillStyle = '#111418';
  ctx.fillRect(0, 0, w, h);
  const gap = 2;
  const barW = (w - gap) / 2;
  drawBar(ctx, 0, barW, barsH, channels[0]);
  drawBar(ctx, barW + gap, barW, barsH, channels[1]);
  // Clip LED.
  ctx.fillStyle = clipped.value ? '#ef4444' : '#27272a';
  ctx.fillRect(0, 0, w, CLIP_LED_H - 2);
}

/** Static placeholder rendering: dim grooves only. */
function drawPlaceholder(): void {
  const canvas = canvasRef.value;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#111418';
  ctx.fillRect(0, 0, props.width, props.height);
  const gap = 2;
  const barW = (props.width - gap) / 2;
  ctx.fillStyle = '#1a1d23';
  ctx.fillRect(0, CLIP_LED_H, barW, props.height - CLIP_LED_H - 1);
  ctx.fillRect(barW + gap, CLIP_LED_H, barW, props.height - CLIP_LED_H - 1);
}

function draw(ts: number): void {
  rafId = requestAnimationFrame(draw);
  const canvas = canvasRef.value;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  const dt = lastTs > 0 ? Math.min((ts - lastTs) / 1000, 0.1) : 0;
  lastTs = ts;
  const levels = props.bridge?.latest;
  advanceMeterChannel(
    channels[0],
    { peakDb: levels?.peakDbL ?? props.minDb, rmsDb: levels?.rmsDbL ?? props.minDb },
    dt,
    ts,
    props.minDb,
  );
  advanceMeterChannel(
    channels[1],
    { peakDb: levels?.peakDbR ?? props.minDb, rmsDb: levels?.rmsDbR ?? props.minDb },
    dt,
    ts,
    props.minDb,
  );
  clipped.value = channels[0].clipped || channels[1].clipped;
  // Silent meters render identically every frame: paint the floor state once,
  // then skip the canvas work until levels rise again.
  const atFloor = channels.every((model) =>
    isMeterAtFloor(model.peakDb, model.rmsDb, model.holdDb, props.minDb),
  );
  if (atFloor && idleFrameDrawn) return;
  idleFrameDrawn = atFloor;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawFrame(ctx);
}

function onClick(): void {
  if (props.placeholder) return;
  for (const channel of channels) resetMeterClip(channel);
  clipped.value = false;
  // The clip LED changed; force a repaint even when the bars are at rest.
  idleFrameDrawn = false;
}

onMounted(() => {
  resizeCanvas();
  if (props.placeholder) drawPlaceholder();
  else rafId = requestAnimationFrame(draw);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
});

watch(
  () => [props.width, props.height] as const,
  () => {
    resizeCanvas();
    if (props.placeholder) drawPlaceholder();
  },
);
</script>

<template>
  <canvas
    ref="canvasRef"
    class="strip-meter"
    :class="{ placeholder: props.placeholder }"
    role="img"
    aria-label="Strip level meter"
    :title="title"
    @click="onClick"
  />
</template>

<style scoped>
.strip-meter {
  display: block;
  background: #111418;
  border-radius: 2px;
  cursor: pointer;
}

.strip-meter.placeholder {
  cursor: default;
  opacity: 0.6;
}
</style>
