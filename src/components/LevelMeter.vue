<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { METER_SILENCE_DB, type MeterBridge } from '@/engine/meters';
import { useI18n } from '@/ui/i18n';
import { isMeterAtFloor } from '@/ui/mixer/meter-model';
import { colorWithAlpha, METER_ZONE_ALPHA, TOKENS } from '@/ui/theme/tokens';

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
  { bridge: null, width: 64, height: 180, minDb: -60 },
);

const { t } = useI18n();

/** Displayed-peak falloff in dB per second. */
const PEAK_DECAY_DB_PER_S = 24;
/** RMS falloff in dB per second (slightly slower for a steadier bar). */
const RMS_DECAY_DB_PER_S = 18;
/** Peak-hold marker hold time in milliseconds before it starts falling. */
const PEAK_HOLD_MS = 1000;
/** Peak-hold marker falloff after the hold time, in dB per second. */
const PEAK_HOLD_DECAY_DB_PER_S = 12;

const GREEN_BELOW_DB = -12;
const YELLOW_BELOW_DB = -6;
const TICK_DBS = [0, -6, -12, -24, -48];

/** Dimmed scale backdrop, derived from the ramp so every meter matches. */
const ZONE_GREEN = colorWithAlpha(TOKENS.meterGreen, METER_ZONE_ALPHA);
const ZONE_YELLOW = colorWithAlpha(TOKENS.meterYellow, METER_ZONE_ALPHA);
const ZONE_RED = colorWithAlpha(TOKENS.meterRed, METER_ZONE_ALPHA);

interface ChannelState {
  peak: number;
  rms: number;
  hold: number;
  holdAt: number;
}

const canvasRef = ref<HTMLCanvasElement | null>(null);
let canvasCtx: CanvasRenderingContext2D | null = null;
let rafId = 0;
let lastTs = 0;
/** True once the floor state was painted; idle frames are then skipped. */
let idleFrameDrawn = false;
const channels: ChannelState[] = [
  { peak: METER_SILENCE_DB, rms: METER_SILENCE_DB, hold: METER_SILENCE_DB, holdAt: 0 },
  { peak: METER_SILENCE_DB, rms: METER_SILENCE_DB, hold: METER_SILENCE_DB, holdAt: 0 },
];

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
  const clamped = Math.min(0, Math.max(props.minDb, db));
  return ((0 - clamped) / (0 - props.minDb)) * h;
}

/** Advances decay/falloff for one channel toward its target levels. */
function updateChannel(
  state: ChannelState,
  targetPeak: number,
  targetRms: number,
  dt: number,
  now: number,
): void {
  state.peak = Math.max(targetPeak, state.peak - PEAK_DECAY_DB_PER_S * dt, props.minDb);
  state.rms = Math.max(targetRms, state.rms - RMS_DECAY_DB_PER_S * dt, props.minDb);
  if (targetPeak >= state.hold) {
    state.hold = targetPeak;
    state.holdAt = now;
  } else if (now - state.holdAt > PEAK_HOLD_MS) {
    state.hold = Math.max(state.hold - PEAK_HOLD_DECAY_DB_PER_S * dt, props.minDb);
  }
}

/** Draws one vertical meter bar (RMS fill + peak cap + hold marker). */
function drawBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  barW: number,
  h: number,
  state: ChannelState,
): void {
  // Zone backdrop (dimmed) so the scale is visible even when silent.
  const yYellow = dbToY(GREEN_BELOW_DB, h);
  const yRed = dbToY(YELLOW_BELOW_DB, h);
  ctx.fillStyle = ZONE_GREEN;
  ctx.fillRect(x, yYellow, barW, h - yYellow);
  ctx.fillStyle = ZONE_YELLOW;
  ctx.fillRect(x, yRed, barW, yYellow - yRed);
  ctx.fillStyle = ZONE_RED;
  ctx.fillRect(x, 0, barW, yRed);

  // RMS fill, clipped per zone for green/yellow/red coloring.
  const yRms = dbToY(state.rms, h);
  const fillZone = (color: string, zoneTop: number, zoneBottom: number): void => {
    const top = Math.max(yRms, zoneTop);
    if (top < zoneBottom) {
      ctx.fillStyle = color;
      ctx.fillRect(x, top, barW, zoneBottom - top);
    }
  };
  fillZone(TOKENS.meterGreen, yYellow, h);
  fillZone(TOKENS.meterYellow, yRed, yYellow);
  fillZone(TOKENS.meterRed, 0, yRed);

  // Peak cap line (color follows its own zone).
  if (state.peak > props.minDb) {
    const yPeak = dbToY(state.peak, h);
    ctx.fillStyle =
      state.peak >= YELLOW_BELOW_DB
        ? TOKENS.meterPeakHot
        : state.peak >= GREEN_BELOW_DB
          ? TOKENS.meterPeakWarm
          : TOKENS.meterPeakCool;
    ctx.fillRect(x, Math.max(0, yPeak - 1), barW, 2);
  }

  // Peak-hold marker.
  if (state.hold > props.minDb) {
    const yHold = dbToY(state.hold, h);
    ctx.fillStyle = TOKENS.meterHold;
    ctx.fillRect(x, Math.max(0, yHold - 0.5), barW, 1);
  }
}

/** Renders one frame: applies decay then draws bars and the dB scale. */
function draw(ts: number): void {
  rafId = requestAnimationFrame(draw);
  const canvas = canvasRef.value;
  const ctx = canvasCtx;
  if (!canvas || !ctx) return;

  const dt = lastTs > 0 ? Math.min((ts - lastTs) / 1000, 0.1) : 0;
  lastTs = ts;

  const levels = props.bridge?.latest;
  updateChannel(channels[0], levels?.peakDbL ?? props.minDb, levels?.rmsDbL ?? props.minDb, dt, ts);
  updateChannel(channels[1], levels?.peakDbR ?? props.minDb, levels?.rmsDbR ?? props.minDb, dt, ts);

  // Silent meters render identically every frame: paint the floor state once,
  // then skip the canvas work until levels rise again.
  const atFloor = channels.every((state) =>
    isMeterAtFloor(state.peak, state.rms, state.hold, props.minDb),
  );
  if (atFloor && idleFrameDrawn) return;
  idleFrameDrawn = atFloor;

  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = props.width;
  const h = props.height;
  ctx.fillStyle = TOKENS.meterWell;
  ctx.fillRect(0, 0, w, h);

  const scaleW = 22;
  const gap = 3;
  const barW = (w - scaleW - gap) / 2;
  drawBar(ctx, 0, barW, h, channels[0]);
  drawBar(ctx, barW + gap, barW, h, channels[1]);

  // dB scale ticks + labels. Every tick gets a mark, but a label is skipped
  // when it would collide with the previous one so compact meters (e.g. the
  // 36px-tall master meter) stay legible instead of stacking numbers.
  ctx.font = '8px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const labelGap = 9;
  let lastLabelY = Number.NEGATIVE_INFINITY;
  for (const db of TICK_DBS) {
    if (db < props.minDb) continue;
    const y = Math.min(h - 4, Math.max(4, dbToY(db, h)));
    ctx.fillStyle = TOKENS.text4;
    ctx.fillRect(2 * barW + gap + 1, y, 4, 1);
    if (y - lastLabelY < labelGap) continue;
    lastLabelY = y;
    ctx.fillStyle = TOKENS.text3;
    ctx.fillText(`${db}`, 2 * barW + gap + 7, y);
  }
}

onMounted(() => {
  resizeCanvas();
  rafId = requestAnimationFrame(draw);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  canvasCtx = null;
});

watch(
  () => [props.width, props.height],
  () => resizeCanvas(),
);
</script>

<template>
  <canvas
    ref="canvasRef"
    class="level-meter"
    :aria-label="t.shell.meters.stereo"
    role="img"
  />
</template>

<style scoped>
/* Same recessed framing as the per-strip meter, so the two read as one
   instrument family rather than two differently-mounted widgets. */
.level-meter {
  display: block;
  background: var(--meter-well);
  border-radius: var(--radius-xs);
  box-shadow: var(--inset-well);
}
</style>
