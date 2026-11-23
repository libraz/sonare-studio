<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useAnimationLoop } from '@/composables/useAnimationLoop';
import type { AnalyserBridge } from '@/engine/analyser';
import type { ScopeSource } from '@/engine/scope';
import { useI18n } from '@/ui/i18n';
import { type GoniometerXY, goniometerXY } from '@/ui/mixer/spectrum-model';
import { colorWithAlpha, TOKENS } from '@/ui/theme/tokens';

/** Scope chrome shared with the spectrum analyzer. */
const SCOPE_WELL = TOKENS.meterWell;
const SCOPE_GRID = colorWithAlpha(TOKENS.border, 0.7);
/** Plotted sample dots — the meter ramp's green at scope weight. */
const TRACE_DOT = colorWithAlpha(TOKENS.meterGreen, 0.7);

/**
 * Goniometer (vectorscope): plots the stereo signal in rotated mid/side space
 * so in-phase (mono) content traces the vertical axis and out-of-phase content
 * the horizontal one. Prefers the engine scope source (per-target, works on any
 * strip) and falls back to the master-only analyser tap; draws a dimmed
 * graticule placeholder when neither is live.
 */

const props = withDefaults(
  defineProps<{
    /** Live master analyser tap; null draws the placeholder graticule. */
    analyser?: AnalyserBridge | null;
    /** Engine scope source (preferred when available); per-target goniometer. */
    scope?: ScopeSource | null;
    /** Square edge length in CSS px. */
    size?: number;
    /** Whether the mixer dock is visible and this analyzer should animate. */
    visible?: boolean;
  }>(),
  { analyser: null, scope: null, size: 48, visible: true },
);

const { t } = useI18n();

const canvasRef = ref<HTMLCanvasElement | null>(null);
/** Reused time-domain scratch, sized to the analyser's scope window. */
let left: Float32Array | null = null;
let right: Float32Array | null = null;
/** Reused interleaved [l, r, ...] scratch for the analyser fallback path. */
let interleaved: Float32Array | null = null;
/** True once a silent frame was painted; idle frames are then skipped. */
let idleFrameDrawn = false;
/** Scope source and engine frame last painted; an unchanged frame is not repainted. */
let paintedScope: ScopeSource | null = null;
let paintedFrame = -1;
/** Reused projection result, so plotting allocates nothing per point. */
const projected: GoniometerXY = { x: 0, y: 0 };

/** Forces the next frame to repaint (canvas cleared or display re-enabled). */
function invalidate(): void {
  idleFrameDrawn = false;
  paintedScope = null;
}

const animation = useAnimationLoop(draw, () => props.visible);

function resizeCanvas(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(props.size * dpr);
  canvas.height = Math.round(props.size * dpr);
  canvas.style.width = `${props.size}px`;
  canvas.style.height = `${props.size}px`;
  invalidate();
}

function drawGraticule(ctx: CanvasRenderingContext2D): void {
  const s = props.size;
  ctx.fillStyle = SCOPE_WELL;
  ctx.fillRect(0, 0, s, s);
  // Diagonal axes: vertical-ish = mono (L=R), the two diagonals = hard L / R.
  ctx.strokeStyle = SCOPE_GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(s, s);
  ctx.moveTo(s, 0);
  ctx.lineTo(0, s);
  ctx.stroke();
}

/** Plots interleaved [l0, r0, l1, r1, ...] points; returns false when silent. */
function plotInterleaved(ctx: CanvasRenderingContext2D, points: Float32Array): boolean {
  const radius = props.size / 2;
  let active = false;
  for (let i = 0; i + 1 < points.length; i += 2) {
    if (Math.abs(points[i]) > 1e-4 || Math.abs(points[i + 1]) > 1e-4) {
      active = true;
      break;
    }
  }
  if (!active && idleFrameDrawn) return true;
  idleFrameDrawn = !active;
  drawGraticule(ctx);
  ctx.fillStyle = TRACE_DOT;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const { x, y } = goniometerXY(points[i], points[i + 1], projected);
    ctx.fillRect(radius + x * radius, radius - y * radius, 1, 1);
  }
  return true;
}

function draw(): void {
  const canvas = canvasRef.value;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Prefer the engine scope (works on any strip); fall back to the analyser.
  const scopeFrame = props.scope?.available ? props.scope.latest : null;
  if (scopeFrame && scopeFrame.points.length > 0) {
    if (props.scope === paintedScope && scopeFrame.frame === paintedFrame) return;
    paintedScope = props.scope;
    paintedFrame = scopeFrame.frame;
    plotInterleaved(ctx, scopeFrame.points);
    return;
  }
  paintedScope = null;

  const analyser = props.analyser;
  if (!analyser?.available) {
    if (idleFrameDrawn) return;
    drawGraticule(ctx);
    idleFrameDrawn = true;
    return;
  }

  if (!left || left.length !== analyser.scopeSize) {
    left = new Float32Array(analyser.scopeSize);
    right = new Float32Array(analyser.scopeSize);
  }
  if (!right || !analyser.readScope(left, right)) return;

  // Interleave the analyser's planar L/R into the shared plot path.
  if (!interleaved || interleaved.length !== left.length * 2) {
    interleaved = new Float32Array(left.length * 2);
  }
  for (let i = 0; i < left.length; i += 1) {
    interleaved[i * 2] = left[i];
    interleaved[i * 2 + 1] = right[i];
  }
  plotInterleaved(ctx, interleaved);
}

onMounted(() => {
  resizeCanvas();
  animation.start();
});

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      invalidate();
      animation.start();
    } else {
      animation.stop();
    }
  },
);

watch(
  () => props.size,
  () => {
    resizeCanvas();
  },
);
</script>

<template>
  <canvas
    ref="canvasRef"
    class="goniometer"
    role="img"
    :aria-label="t.shell.mixer.analyzer.goniometer"
    v-tooltip="t.shell.mixer.analyzer.goniometer"
  />
</template>

<style scoped>
.goniometer {
  display: block;
  background: var(--meter-well);
  border-radius: var(--radius-xs);
  box-shadow: var(--inset-well);
}
</style>
