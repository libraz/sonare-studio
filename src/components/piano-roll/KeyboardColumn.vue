<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { getCanvasContext, isBlackKey, PIANO_ROLL_COLORS, setupCanvas } from './theme';

/**
 * Fixed piano keyboard column on the left edge of the piano roll. Renders one
 * key per pitch row, vertically synced with the note grid through the shared
 * TimelineRange, with octave labels on the C keys.
 */

const props = defineProps<{
  /** Shared timeline viewport (read-only here; the note grid owns resizing). */
  range: TimelineRange;
  /** Monotonic counter bumped by the container after view mutations. */
  revision: number;
  /** Shared frame batcher for canvas redraws. */
  painter: Painter;
}>();

const wrapper = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);

/** Unique painter layer suffix so several editors can share one painter. */
const layerId = Math.random().toString(36).slice(2, 8);

const COLORS = PIANO_ROLL_COLORS;

/** Fraction of the column width covered by black keys. */
const BLACK_KEY_WIDTH_RATIO = 0.62;
/** Minimum row height before octave labels are drawn. */
const MIN_LABEL_ROW_HEIGHT = 8;

let widthPx = 0;
let heightPx = 0;

function schedule(): void {
  props.painter.schedule(`keyboard-column-${layerId}`, draw);
}

/** Returns the octave label for a C pitch (MIDI 60 = C4). */
function octaveLabel(pitch: number): string {
  return `C${Math.floor(pitch / 12) - 1}`;
}

function draw(): void {
  const el = canvas.value;
  if (!el || widthPx <= 0 || heightPx <= 0) return;
  const ctx = getCanvasContext(el);
  if (!ctx) return;
  const range = props.range;

  ctx.fillStyle = COLORS.keyWhite;
  ctx.fillRect(0, 0, widthPx, heightPx);

  const lowPitch = range.yToPitch(heightPx - 1);
  const highPitch = range.yToPitch(0);
  for (let pitch = lowPitch; pitch <= highPitch; pitch++) {
    const y = range.pitchToY(pitch);
    const pc = ((pitch % 12) + 12) % 12;
    if (isBlackKey(pitch)) {
      ctx.fillStyle = COLORS.keyBlack;
      ctx.fillRect(0, y, widthPx * BLACK_KEY_WIDTH_RATIO, range.rowHeight);
      // Black keys sit on a half-height groove line across the white area.
      ctx.fillStyle = COLORS.keyLine;
      const mid = y + range.rowHeight / 2;
      ctx.fillRect(widthPx * BLACK_KEY_WIDTH_RATIO, Math.round(mid), widthPx, 1);
    } else if (pc === 0 || pc === 5) {
      // White-key separators fall between B/C and E/F.
      ctx.fillStyle = COLORS.keyLine;
      ctx.fillRect(0, y + range.rowHeight - 1, widthPx, 1);
    }
    if (pc === 0 && range.rowHeight >= MIN_LABEL_ROW_HEIGHT) {
      ctx.fillStyle = COLORS.keyLabel;
      ctx.font = `${Math.min(10, range.rowHeight - 2)}px system-ui, sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(octaveLabel(pitch), widthPx - 4, y + range.rowHeight / 2);
    }
  }

  // Right border separating the keyboard from the grid.
  ctx.fillStyle = COLORS.keyLine;
  ctx.fillRect(widthPx - 1, 0, 1, heightPx);
}

let resizeObserver: ResizeObserver | null = null;

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
  resizeObserver = null;
});

watch(
  () => props.revision,
  () => schedule(),
);
</script>

<template>
  <div ref="wrapper" class="keyboard-column">
    <canvas ref="canvas" class="keyboard-canvas" role="img" aria-label="Piano keyboard" />
  </div>
</template>

<style scoped>
.keyboard-column {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.keyboard-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
</style>
