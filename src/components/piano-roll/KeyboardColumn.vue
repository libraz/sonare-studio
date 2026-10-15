<script setup lang="ts">
import { ref, watch } from 'vue';
import { useNoteNames } from '@/composables/useNoteNames';
import type { Painter } from '@/ui/canvas/painter';
import { MAX_PITCH, MIN_PITCH, type TimelineRange } from '@/ui/canvas/timeline-range';
import { createLayerId, useCanvasSurface } from '@/ui/canvas/use-canvas-surface';
import { useI18n } from '@/ui/i18n';
import { CANVAS_FONT_SIZE_PX, canvasFont } from '@/ui/theme/tokens';
import { getCanvasContext, isBlackKey, PIANO_ROLL_COLORS } from './theme';

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
  /** Plays a short preview for a clicked key. */
  audition?: (pitch: number, velocity: number) => void;
}>();

const wrapper = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const { t } = useI18n();
const { pitchClassNames, system: noteNameSystem } = useNoteNames();

/** Unique painter layer suffix so several editors can share one painter. */
const layerId = createLayerId();

const COLORS = PIANO_ROLL_COLORS;

/** Fraction of the column width covered by black keys. */
const BLACK_KEY_WIDTH_RATIO = 0.62;
/** Minimum row height before octave labels are drawn. */
const MIN_LABEL_ROW_HEIGHT = 8;

const surface = useCanvasSurface({
  container: wrapper,
  canvases: () => [canvas.value],
  redraw: schedule,
});

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !props.audition) return;
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const pitch = Math.max(
    MIN_PITCH,
    Math.min(MAX_PITCH, Math.round(props.range.yToPitch(event.clientY - bounds.top))),
  );
  props.audition(pitch, 96);
}

/** Everything about the range that the painted keys depend on. */
function viewKey(): string {
  return `${props.range.scrollY}:${props.range.rowHeight}:${surface.heightPx}`;
}

let paintedViewKey = '';

function schedule(): void {
  props.painter.schedule(`keyboard-column-${layerId}`, draw);
}

/** Returns the octave label for a C pitch (MIDI 60 = C4). */
function octaveLabel(pitch: number): string {
  return `${pitchClassNames.value[0]}${Math.floor(pitch / 12) - 1}`;
}

function draw(): void {
  const el = canvas.value;
  if (!el || surface.widthPx <= 0 || surface.heightPx <= 0) return;
  const ctx = getCanvasContext(el);
  if (!ctx) return;
  const range = props.range;
  paintedViewKey = viewKey();

  ctx.fillStyle = COLORS.keyWhite;
  ctx.fillRect(0, 0, surface.widthPx, surface.heightPx);

  const lowPitch = range.yToPitch(surface.heightPx - 1);
  const highPitch = range.yToPitch(0);
  for (let pitch = lowPitch; pitch <= highPitch; pitch++) {
    const y = range.pitchToY(pitch);
    const pc = ((pitch % 12) + 12) % 12;
    if (isBlackKey(pitch)) {
      ctx.fillStyle = COLORS.keyBlack;
      ctx.fillRect(0, y, surface.widthPx * BLACK_KEY_WIDTH_RATIO, range.rowHeight);
      // Black keys sit on a half-height groove line across the white area.
      ctx.fillStyle = COLORS.keyLine;
      const mid = y + range.rowHeight / 2;
      ctx.fillRect(surface.widthPx * BLACK_KEY_WIDTH_RATIO, Math.round(mid), surface.widthPx, 1);
    } else if (pc === 0 || pc === 5) {
      // White-key separators fall between B/C and E/F.
      ctx.fillStyle = COLORS.keyLine;
      ctx.fillRect(0, y + range.rowHeight - 1, surface.widthPx, 1);
    }
    if (pc === 0 && range.rowHeight >= MIN_LABEL_ROW_HEIGHT) {
      ctx.fillStyle = COLORS.keyLabel;
      ctx.font = canvasFont(Math.min(CANVAS_FONT_SIZE_PX.meta, range.rowHeight - 2));
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(octaveLabel(pitch), surface.widthPx - 4, y + range.rowHeight / 2);
    }
  }

  // Right border separating the keyboard from the grid.
  ctx.fillStyle = COLORS.keyLine;
  ctx.fillRect(surface.widthPx - 1, 0, 1, surface.heightPx);
}

// Horizontal pans and zooms bump the revision too but leave the keys unchanged.
watch(
  () => props.revision,
  () => {
    if (viewKey() !== paintedViewKey) schedule();
  },
);

// The key labels are painted, so a renamed system has to repaint the column.
watch(noteNameSystem, () => schedule());
</script>

<template>
  <div
    ref="wrapper"
    class="keyboard-column"
    :class="{ auditionable: audition !== undefined }"
    @pointerdown="onPointerDown"
  >
    <canvas ref="canvas" class="keyboard-canvas" role="img" :aria-label="t.shell.pianoRoll.keyboard" />
  </div>
</template>

<style scoped>
.keyboard-column {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

/* The column plays the key under the pointer once the editor supplies an
 * audition hook. Nothing else on a painted canvas says it is interactive. */
.keyboard-column.auditionable {
  cursor: pointer;
}

.keyboard-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
</style>
