<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useAnimationLoop } from '@/composables/useAnimationLoop';
import type { MeterBridge } from '@/engine/meters';
import { clamp } from '@/lib/math';
import { useI18n } from '@/ui/i18n';
import { drawMeterBar } from '@/ui/mixer/meter-draw';
import {
  advanceMeterChannel,
  createMeterChannel,
  isMeterAtFloor,
  METER_MIN_DB,
  type MeterChannelModel,
  meterFraction,
  resetMeterClip,
} from '@/ui/mixer/meter-model';
import { CANVAS_FONT_SIZE_PX, canvasFont, TOKENS } from '@/ui/theme/tokens';

const props = withDefaults(
  defineProps<{
    /** Meter bridge supplying the latest stereo levels; null draws a silent meter. */
    bridge?: MeterBridge | null;
    /** Canvas width in CSS pixels. */
    width?: number;
    /** Canvas height in CSS pixels. */
    height?: number;
    /** Bottom of the visible dB range (top is 0 dBFS). */
    minDb?: number;
  }>(),
  { bridge: null, width: 64, height: 180, minDb: METER_MIN_DB },
);

const { t } = useI18n();

const TICK_DBS = [0, -6, -12, -24, -48];

/** Width of the dB scale lane right of the bars; mirrored by the clip flash in CSS. */
const SCALE_W = 22;
/** Height of the clip LED drawn at the top of the scale lane; mirrored in CSS. */
const CLIP_LED_H = 3;
const cssScaleW = `${SCALE_W}px`;
const cssClipLedH = `${CLIP_LED_H}px`;

const canvasRef = ref<HTMLCanvasElement | null>(null);
let canvasCtx: CanvasRenderingContext2D | null = null;
/** True once the floor state was painted; idle frames are then skipped. */
let idleFrameDrawn = false;
const channels: MeterChannelModel[] = [
  createMeterChannel(props.minDb),
  createMeterChannel(props.minDb),
];
const clipped = ref(false);

/** Resizes the canvas backing store for the current devicePixelRatio. */
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

/** Maps a dB value to a y coordinate (0 dB at top, minDb at bottom). */
function dbToY(db: number, h: number): number {
  return (1 - meterFraction(db, props.minDb)) * h;
}

/** Renders one frame: applies decay then draws bars and the dB scale. */
function draw(ts: number, dt: number): void {
  const canvas = canvasRef.value;
  const ctx = canvasCtx;
  if (!canvas || !ctx) return;

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
  const atFloor = channels.every((state) =>
    isMeterAtFloor(state.peakDb, state.rmsDb, state.holdDb, props.minDb),
  );
  if (atFloor && idleFrameDrawn) return;
  idleFrameDrawn = atFloor;

  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = props.width;
  const h = props.height;
  ctx.fillStyle = TOKENS.meterWell;
  ctx.fillRect(0, 0, w, h);

  const scaleW = SCALE_W;
  const gap = 3;
  const barW = (w - scaleW - gap) / 2;
  drawMeterBar(ctx, channels[0], 0, barW, 0, h, props.minDb);
  drawMeterBar(ctx, channels[1], barW + gap, barW, 0, h, props.minDb);

  // Keep the clip indicator in the scale lane so the transport meter retains
  // its existing bar dimensions while exposing the same latch as StripMeter.
  ctx.fillStyle = clipped.value ? TOKENS.meterRed : TOKENS.meterClipOff;
  ctx.fillRect(2 * barW + gap, 0, scaleW, CLIP_LED_H);

  // dB scale ticks + labels. Every tick gets a mark, but a label is skipped
  // when it would collide with the previous one so compact meters (e.g. the
  // 36px-tall master meter) stay legible instead of stacking numbers.
  ctx.font = canvasFont(CANVAS_FONT_SIZE_PX.chromeMd);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const labelGap = 9;
  let lastLabelY = Number.NEGATIVE_INFINITY;
  for (const db of TICK_DBS) {
    if (db < props.minDb) continue;
    const y = clamp(dbToY(db, h), 4, h - 4);
    ctx.fillStyle = TOKENS.text4;
    ctx.fillRect(2 * barW + gap + 1, y, 4, 1);
    if (y - lastLabelY < labelGap) continue;
    lastLabelY = y;
    ctx.fillStyle = TOKENS.text3;
    ctx.fillText(`${db}`, 2 * barW + gap + 7, y);
  }
}

function onClick(): void {
  for (const channel of channels) {
    resetMeterClip(channel);
    channel.holdDb = props.minDb;
    channel.holdAtMs = 0;
  }
  clipped.value = false;
  // The clip LED changed; force a repaint even when the bars are at rest.
  idleFrameDrawn = false;
}

const animation = useAnimationLoop(draw);

onMounted(() => {
  resizeCanvas();
  animation.start();
});

onBeforeUnmount(() => {
  canvasCtx = null;
});

watch(
  () => [props.width, props.height],
  () => resizeCanvas(),
);
</script>

<template>
  <span class="level-meter-wrap" :class="{ clipped }">
    <canvas
      ref="canvasRef"
      class="level-meter"
      :aria-label="clipped ? t.shell.mixer.meter.clipped : t.shell.meters.stereo"
      role="img"
      v-tooltip="t.shell.meters.resetTitle"
      @click="onClick"
    />
    <span class="clip-flash" aria-hidden="true" />
  </span>
</template>

<style scoped>
.level-meter-wrap {
  position: relative;
  display: block;
}

/* Same recessed framing as the per-strip meter, so the two read as one
   instrument family rather than two differently-mounted widgets. */
.level-meter {
  display: block;
  background: var(--meter-well);
  border-radius: var(--radius-xs);
  box-shadow: var(--inset-well);
  cursor: pointer;
}

/* One-shot burst over the canvas clip LED when the latch trips; the canvas
   keeps the latched state, so only the onset animates. */
.clip-flash {
  position: absolute;
  top: 0;
  right: 0;
  width: v-bind(cssScaleW);
  height: v-bind(cssClipLedH);
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
