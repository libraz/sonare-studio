<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { MeterSource } from '@/engine/meters';
import { useI18n } from '@/ui/i18n';
import {
  advanceMeterChannel,
  createMeterChannel,
  isMeterAtFloor,
  METER_MIN_DB,
  type MeterChannelModel,
  meterFraction,
  resetMeterClip,
} from '@/ui/mixer/meter-model';
import { colorWithAlpha, METER_ZONE_ALPHA, TOKENS } from '@/ui/theme/tokens';

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
    /** Whether the mixer dock is visible and this meter should animate. */
    visible?: boolean;
  }>(),
  { bridge: null, placeholder: false, width: 12, height: 132, minDb: METER_MIN_DB, visible: true },
);

/** Height of the clip LED row at the top, in px. */
const CLIP_LED_H = 7;

const GREEN_BELOW_DB = -12;
const YELLOW_BELOW_DB = -6;

/** Dimmed scale backdrop, derived from the ramp so every meter matches. */
const ZONE_GREEN = colorWithAlpha(TOKENS.meterGreen, METER_ZONE_ALPHA);
const ZONE_YELLOW = colorWithAlpha(TOKENS.meterYellow, METER_ZONE_ALPHA);
const ZONE_RED = colorWithAlpha(TOKENS.meterRed, METER_ZONE_ALPHA);
/** Placeholder groove: the well lifted just enough to read as a dead channel. */
const PLACEHOLDER_GROOVE = colorWithAlpha(TOKENS.text4, 0.12);

const canvasRef = ref<HTMLCanvasElement | null>(null);
let canvasCtx: CanvasRenderingContext2D | null = null;
let rafId = 0;
let lastTs = 0;
/** True once the floor state was painted; idle frames are then skipped. */
let idleFrameDrawn = false;
const channels: MeterChannelModel[] = [
  createMeterChannel(props.minDb),
  createMeterChannel(props.minDb),
];

const clipped = ref(false);
const { t } = useI18n();

const title = computed(() =>
  props.placeholder
    ? t.value.shell.mixer.meter.noLive
    : clipped.value
      ? t.value.shell.mixer.meter.clipped
      : t.value.shell.mixer.meter.stereo,
);

function resizeCanvas(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(props.width * dpr);
  canvas.height = Math.round(props.height * dpr);
  canvas.style.width = `${props.width}px`;
  canvas.style.height = `${props.height}px`;
  canvasCtx = canvas.getContext('2d');
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
  ctx.fillStyle = ZONE_GREEN;
  ctx.fillRect(x, yYellow, barW, bottom - yYellow);
  ctx.fillStyle = ZONE_YELLOW;
  ctx.fillRect(x, yRed, barW, yYellow - yRed);
  ctx.fillStyle = ZONE_RED;
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
  fillZone(TOKENS.meterGreen, yYellow, bottom);
  fillZone(TOKENS.meterYellow, yRed, yYellow);
  fillZone(TOKENS.meterRed, CLIP_LED_H, yRed);
  // Peak cap — zone-coloured, matching the master meter's cap exactly.
  if (model.peakDb > props.minDb) {
    const yPeak = dbToY(model.peakDb, barsH);
    ctx.fillStyle =
      model.peakDb >= YELLOW_BELOW_DB
        ? TOKENS.meterPeakHot
        : model.peakDb >= GREEN_BELOW_DB
          ? TOKENS.meterPeakWarm
          : TOKENS.meterPeakCool;
    ctx.fillRect(x, Math.max(CLIP_LED_H, yPeak - 1), barW, 1.5);
  }
  // Peak-hold marker.
  if (model.holdDb > props.minDb) {
    const yHold = dbToY(model.holdDb, barsH);
    ctx.fillStyle = TOKENS.meterHold;
    ctx.fillRect(x, Math.max(CLIP_LED_H, yHold - 0.5), barW, 1);
  }
}

function drawFrame(ctx: CanvasRenderingContext2D): void {
  const w = props.width;
  const h = props.height;
  const barsH = h - CLIP_LED_H - 1;
  ctx.fillStyle = TOKENS.meterWell;
  ctx.fillRect(0, 0, w, h);
  const gap = 2;
  const barW = (w - gap) / 2;
  drawBar(ctx, 0, barW, barsH, channels[0]);
  drawBar(ctx, barW + gap, barW, barsH, channels[1]);
  // Clip LED.
  ctx.fillStyle = clipped.value ? TOKENS.meterRed : TOKENS.meterClipOff;
  ctx.fillRect(0, 0, w, CLIP_LED_H - 2);
}

/** Static placeholder rendering: dim grooves only. */
function drawPlaceholder(): void {
  const canvas = canvasRef.value;
  const ctx = canvasCtx;
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = TOKENS.meterWell;
  ctx.fillRect(0, 0, props.width, props.height);
  const gap = 2;
  const barW = (props.width - gap) / 2;
  ctx.fillStyle = PLACEHOLDER_GROOVE;
  ctx.fillRect(0, CLIP_LED_H, barW, props.height - CLIP_LED_H - 1);
  ctx.fillRect(barW + gap, CLIP_LED_H, barW, props.height - CLIP_LED_H - 1);
}

function stopAnimation(): void {
  if (rafId !== 0) cancelAnimationFrame(rafId);
  rafId = 0;
  lastTs = 0;
}

function startAnimation(): void {
  if (!props.visible || rafId !== 0) return;
  rafId = requestAnimationFrame(draw);
}

function draw(ts: number): void {
  if (!props.visible) {
    rafId = 0;
    return;
  }
  rafId = requestAnimationFrame(draw);
  const canvas = canvasRef.value;
  const ctx = canvasCtx;
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
  else startAnimation();
});

onBeforeUnmount(() => {
  stopAnimation();
  canvasCtx = null;
});

watch(
  () => props.placeholder,
  (placeholder) => {
    if (placeholder) {
      stopAnimation();
      drawPlaceholder();
    } else {
      idleFrameDrawn = false;
      startAnimation();
    }
  },
);

watch(
  () => props.visible,
  (visible) => {
    if (!visible) {
      stopAnimation();
      return;
    }
    idleFrameDrawn = false;
    if (props.placeholder) drawPlaceholder();
    else startAnimation();
  },
);

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
    :aria-label="t.shell.mixer.meter.strip"
    v-tooltip="title"
    @click="onClick"
  />
</template>

<style scoped>
.strip-meter {
  display: block;
  background: var(--meter-well);
  border-radius: var(--radius-xs);
  box-shadow: var(--inset-well);
  cursor: pointer;
}

.strip-meter.placeholder {
  cursor: default;
  opacity: 0.6;
}
</style>
