<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { AnalyserBridge } from '@/engine/analyser';
import type { ScopeSource } from '@/engine/scope';
import { useI18n } from '@/ui/i18n';
import {
  binFrequency,
  frequencyToFraction,
  SPECTRUM_MAX_FREQ,
  SPECTRUM_MIN_DB,
  SPECTRUM_MIN_FREQ,
  spectrumDbToFraction,
} from '@/ui/mixer/spectrum-model';
import { colorWithAlpha, TOKENS } from '@/ui/theme/tokens';

/** Scope chrome shared with the goniometer: canvas well and graticule lines. */
const SCOPE_WELL = TOKENS.meterWell;
const SCOPE_GRID = colorWithAlpha(TOKENS.border, 0.7);
/** Magnitude curve — the meter ramp's green, so scopes match the meters. */
const TRACE_FILL = colorWithAlpha(TOKENS.meterGreen, 0.22);

/**
 * Spectrum analyzer: a log-frequency, dB-magnitude curve. Prefers the engine
 * scope source (per-target FFT bands, available on any strip) and falls back to
 * the master-only Web Audio analyser tap. Renders a dimmed grid placeholder
 * when neither is live; skips canvas work while the signal is silent.
 */

const props = withDefaults(
  defineProps<{
    /** Live master analyser tap; null draws the placeholder grid. */
    analyser?: AnalyserBridge | null;
    /** Engine scope source (preferred when available); per-target spectrum. */
    scope?: ScopeSource | null;
    /** Canvas width in CSS px. */
    width?: number;
    /** Canvas height in CSS px. */
    height?: number;
    /** Whether the mixer dock is visible and this analyzer should animate. */
    visible?: boolean;
  }>(),
  { analyser: null, scope: null, width: 90, height: 48, visible: true },
);

const { t } = useI18n();

/** Octave grid lines drawn behind the curve (Hz). */
const GRID_FREQS = [100, 1000, 10000];

const canvasRef = ref<HTMLCanvasElement | null>(null);
let rafId = 0;
/** Reused FFT magnitude scratch (dBFS per bin), sized to the analyser. */
let bins: Float32Array | null = null;
/** True once a silent frame was painted; idle frames are then skipped. */
let idleFrameDrawn = false;
/** Scope source and engine frame last painted; an unchanged frame is not repainted. */
let paintedScope: ScopeSource | null = null;
let paintedFrame = -1;

/** Forces the next frame to repaint (canvas cleared or display re-enabled). */
function invalidate(): void {
  idleFrameDrawn = false;
  paintedScope = null;
}

function stopAnimation(): void {
  if (rafId !== 0) cancelAnimationFrame(rafId);
  rafId = 0;
}

function startAnimation(): void {
  if (!props.visible || rafId !== 0) return;
  rafId = requestAnimationFrame(draw);
}

function resizeCanvas(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(props.width * dpr);
  canvas.height = Math.round(props.height * dpr);
  canvas.style.width = `${props.width}px`;
  canvas.style.height = `${props.height}px`;
  invalidate();
}

function drawGrid(ctx: CanvasRenderingContext2D): void {
  const w = props.width;
  const h = props.height;
  ctx.fillStyle = SCOPE_WELL;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = SCOPE_GRID;
  ctx.lineWidth = 1;
  for (const freq of GRID_FREQS) {
    const x = Math.round(frequencyToFraction(freq, SPECTRUM_MIN_FREQ, SPECTRUM_MAX_FREQ) * w) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
}

/**
 * Strokes and fills a magnitude curve over `dbs[first..]`, placing entry `i`
 * at `freqOf(i)` Hz.
 */
function strokeCurve(
  ctx: CanvasRenderingContext2D,
  dbs: Float32Array,
  first: number,
  freqOf: (index: number) => number,
): void {
  const w = props.width;
  const h = props.height;
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = first; i < dbs.length; i += 1) {
    const freq = freqOf(i);
    if (freq < SPECTRUM_MIN_FREQ) continue;
    if (freq > SPECTRUM_MAX_FREQ) break;
    const x = frequencyToFraction(freq, SPECTRUM_MIN_FREQ, SPECTRUM_MAX_FREQ) * w;
    const y = (1 - spectrumDbToFraction(dbs[i])) * h;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = TRACE_FILL;
  ctx.fill();
  ctx.strokeStyle = TOKENS.meterGreen;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** True when at least one dB value rises meaningfully above the floor. */
function anyActive(values: Float32Array): boolean {
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] > SPECTRUM_MIN_DB + 0.5) return true;
  }
  return false;
}

/** Renders the engine scope bands (linear bands over [0, Nyquist]). */
function drawScope(ctx: CanvasRenderingContext2D, scope: ScopeSource): boolean {
  const frame = scope.latest;
  if (!frame || frame.bands.length === 0) return false;
  if (scope === paintedScope && frame.frame === paintedFrame) return true;
  paintedScope = scope;
  paintedFrame = frame.frame;
  const bands = frame.bands;
  const active = anyActive(bands);
  if (!active && idleFrameDrawn) return true;
  idleFrameDrawn = !active;
  drawGrid(ctx);
  const nyquist = scope.sampleRate / 2;
  const count = bands.length;
  // Band b spans [b/count, (b+1)/count] * Nyquist; use its center.
  strokeCurve(ctx, bands, 0, (b) => ((b + 0.5) / count) * nyquist);
  return true;
}

/** Renders the Web Audio analyser FFT bins (master fallback). */
function drawAnalyser(ctx: CanvasRenderingContext2D, analyser: AnalyserBridge): void {
  if (!bins || bins.length !== analyser.frequencyBinCount) {
    bins = new Float32Array(analyser.frequencyBinCount);
  }
  if (!analyser.readSpectrum(bins)) return;
  const active = anyActive(bins);
  if (!active && idleFrameDrawn) return;
  idleFrameDrawn = !active;
  drawGrid(ctx);
  // Skip the DC bin.
  strokeCurve(ctx, bins, 1, (i) => binFrequency(i, analyser.sampleRate, analyser.fftSize));
}

function draw(): void {
  if (!props.visible) {
    rafId = 0;
    return;
  }
  rafId = requestAnimationFrame(draw);
  const canvas = canvasRef.value;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Prefer the engine scope (works for any strip); fall back to the analyser.
  if (props.scope?.available && drawScope(ctx, props.scope)) return;
  paintedScope = null;
  if (props.analyser?.available) {
    drawAnalyser(ctx, props.analyser);
    return;
  }
  if (idleFrameDrawn) return;
  drawGrid(ctx);
  idleFrameDrawn = true;
}

onMounted(() => {
  resizeCanvas();
  startAnimation();
});

onBeforeUnmount(() => {
  stopAnimation();
});

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      invalidate();
      startAnimation();
    } else {
      stopAnimation();
    }
  },
);

watch(
  () => [props.width, props.height] as const,
  () => {
    resizeCanvas();
  },
);
</script>

<template>
  <canvas
    ref="canvasRef"
    class="spectrum"
    role="img"
    :aria-label="t.shell.mixer.analyzer.spectrum"
    v-tooltip="t.shell.mixer.analyzer.spectrum"
  />
</template>

<style scoped>
.spectrum {
  display: block;
  width: 100%;
  background: var(--meter-well);
  border-radius: var(--radius-xs);
  box-shadow: var(--inset-well);
}
</style>
