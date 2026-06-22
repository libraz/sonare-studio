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
  }>(),
  { analyser: null, scope: null, width: 90, height: 48 },
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

function resizeCanvas(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(props.width * dpr);
  canvas.height = Math.round(props.height * dpr);
  canvas.style.width = `${props.width}px`;
  canvas.style.height = `${props.height}px`;
  idleFrameDrawn = false;
}

function drawGrid(ctx: CanvasRenderingContext2D): void {
  const w = props.width;
  const h = props.height;
  ctx.fillStyle = '#0c0f14';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#1c2230';
  ctx.lineWidth = 1;
  for (const freq of GRID_FREQS) {
    const x = Math.round(frequencyToFraction(freq, SPECTRUM_MIN_FREQ, SPECTRUM_MAX_FREQ) * w) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
}

/** Strokes and fills a magnitude curve from (frequency, dB) sample pairs. */
function strokeCurve(
  ctx: CanvasRenderingContext2D,
  samples: Iterable<readonly [freq: number, db: number]>,
): void {
  const w = props.width;
  const h = props.height;
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (const [freq, db] of samples) {
    if (freq < SPECTRUM_MIN_FREQ) continue;
    if (freq > SPECTRUM_MAX_FREQ) break;
    const x = frequencyToFraction(freq, SPECTRUM_MIN_FREQ, SPECTRUM_MAX_FREQ) * w;
    const y = (1 - spectrumDbToFraction(db)) * h;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(34, 197, 94, 0.22)';
  ctx.fill();
  ctx.strokeStyle = '#22c55e';
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
  const bands = frame.bands;
  const active = anyActive(bands);
  if (!active && idleFrameDrawn) return true;
  idleFrameDrawn = !active;
  drawGrid(ctx);
  const nyquist = scope.sampleRate / 2;
  const count = bands.length;
  strokeCurve(
    ctx,
    (function* () {
      for (let b = 0; b < count; b += 1) {
        // Band b spans [b/count, (b+1)/count] * Nyquist; use its center.
        yield [((b + 0.5) / count) * nyquist, bands[b]] as const;
      }
    })(),
  );
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
  strokeCurve(
    ctx,
    (function* () {
      // Skip the DC bin.
      for (let i = 1; i < (bins as Float32Array).length; i += 1) {
        yield [
          binFrequency(i, analyser.sampleRate, analyser.fftSize),
          (bins as Float32Array)[i],
        ] as const;
      }
    })(),
  );
}

function draw(): void {
  rafId = requestAnimationFrame(draw);
  const canvas = canvasRef.value;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Prefer the engine scope (works for any strip); fall back to the analyser.
  if (props.scope?.available && drawScope(ctx, props.scope)) return;
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
  rafId = requestAnimationFrame(draw);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
});

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
    :title="t.shell.mixer.analyzer.spectrum"
  />
</template>

<style scoped>
.spectrum {
  display: block;
  width: 100%;
  background: var(--surface-inset);
  border-radius: 2px;
  box-shadow: var(--inset-well);
}
</style>
