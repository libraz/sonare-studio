<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { MeterSource } from '@/engine/meters';
import { useI18n } from '@/ui/i18n';
import { FADER_HEIGHT, formatDb } from '@/ui/mixer/db-scale';
import { drawMeterBar } from '@/ui/mixer/meter-draw';
import {
  advanceMeterChannel,
  createMeterChannel,
  isMeterAtFloor,
  METER_MIN_DB,
  type MeterChannelModel,
  resetMeterClip,
} from '@/ui/mixer/meter-model';
import { colorWithAlpha, TOKENS } from '@/ui/theme/tokens';

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
  {
    bridge: null,
    placeholder: false,
    width: 12,
    height: FADER_HEIGHT,
    minDb: METER_MIN_DB,
    visible: true,
  },
);

/** Height of the clip LED row at the top, in px. */
const CLIP_LED_H = 7;

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

/**
 * The peak readout changes on most frames while the hold decays, so it is
 * written straight to the DOM instead of re-rendering the component.
 */
const peakRef = ref<HTMLElement | null>(null);
let peakText = '';

/** Displays the floor as silence while preserving numeric peak values above it. */
function showPeakHold(holdDb: number): void {
  const text = holdDb <= props.minDb ? '-inf' : formatDb(holdDb);
  if (text === peakText || !peakRef.value) return;
  peakText = text;
  peakRef.value.textContent = text;
}

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

function drawFrame(ctx: CanvasRenderingContext2D): void {
  const w = props.width;
  const h = props.height;
  const barsH = h - CLIP_LED_H - 1;
  ctx.fillStyle = TOKENS.meterWell;
  ctx.fillRect(0, 0, w, h);
  const gap = 2;
  const barW = (w - gap) / 2;
  drawMeterBar(ctx, channels[0], 0, barW, CLIP_LED_H, barsH, props.minDb);
  drawMeterBar(ctx, channels[1], barW + gap, barW, CLIP_LED_H, barsH, props.minDb);
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
  showPeakHold(Math.max(channels[0].holdDb, channels[1].holdDb));
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
  for (const channel of channels) {
    resetMeterClip(channel);
    channel.holdDb = props.minDb;
    channel.holdAtMs = 0;
  }
  clipped.value = false;
  showPeakHold(props.minDb);
  // The clip LED changed; force a repaint even when the bars are at rest.
  idleFrameDrawn = false;
}

onMounted(() => {
  showPeakHold(props.minDb);
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
  <div class="strip-meter-wrap" :class="{ clipped }">
    <canvas
      ref="canvasRef"
      class="strip-meter"
      :class="{ placeholder: props.placeholder }"
      role="img"
      :aria-label="t.shell.mixer.meter.strip"
      v-tooltip="title"
      @click="onClick"
    />
    <span
      v-if="!props.placeholder"
      class="clip-flash"
      :style="{ width: `${props.width}px`, height: `${CLIP_LED_H - 2}px` }"
      aria-hidden="true"
    />
    <span ref="peakRef" class="strip-meter-peak" />
  </div>
</template>

<style scoped>
.strip-meter {
  display: block;
  background: var(--meter-well);
  border-radius: var(--radius-xs);
  box-shadow: var(--inset-well);
  cursor: pointer;
}

.strip-meter-wrap { position: relative; display: flex; flex-direction: column; align-items: center; gap: 1px; }
.strip-meter-peak { font: var(--fw-medium) var(--fs-2xs) var(--font-mono); color: var(--text-4); }

.strip-meter.placeholder {
  cursor: default;
  opacity: 0.6;
}

/* One-shot burst over the canvas clip LED when the latch trips; the canvas
   keeps the latched state, so only the onset animates. */
.clip-flash {
  position: absolute;
  top: 0;
  left: 50%;
  translate: -50% 0;
  border-radius: 1px;
  background: var(--meter-red);
  box-shadow: 0 0 6px 1px color-mix(in srgb, var(--meter-red) 70%, transparent);
  opacity: 0;
  pointer-events: none;
}

.clipped .clip-flash {
  animation: clip-trip calc(var(--dur-3) * 2.5) var(--ease-out);
}

@keyframes clip-trip {
  from {
    opacity: 1;
  }
}
</style>
