<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { setSelection, updateNotes } from '@/project/commands';
import type { EditorNote, EditorNoteUpdate } from '@/project/types';
import { observeDevicePixelRatio } from '@/ui/canvas/device-pixel-ratio';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { useI18n } from '@/ui/i18n';
import { CANVAS_FONT_SIZE_PX, canvasFont } from '@/ui/theme/tokens';
import {
  barsInSpan,
  formatLaneValue,
  type LaneBar,
  type LaneParamId,
  laneBarRect,
  laneParamSpec,
  laneUpdateForValue,
  laneValueFromY,
  noteLaneValue,
  quantizeLaneValue,
  rampValueAt,
} from './lane-params';
import {
  DEFAULT_NOTE_COLOR,
  getCanvasContext,
  type NoteColorFn,
  PIANO_ROLL_COLORS,
  setupCanvas,
} from './theme';

/**
 * Parameter lane below the note grid: one draggable bar per note, horizontally
 * aligned with the grid through the shared TimelineRange. The `param` prop
 * selects which note field the bars show (note-on velocity by default; see
 * lane-params.ts for the catalog). Dragging a bar sets the value of the
 * grabbed note (and of the whole selection when the grabbed note is
 * selected); sweeping the pointer across other bars paints each touched note,
 * and alt-drag draws a linear value ramp from the gesture anchor to the
 * pointer. Every gesture commits as one undo step on release.
 */

const props = defineProps<{
  /** Shared timeline viewport (horizontal mapping only). */
  range: TimelineRange;
  /** Monotonic counter bumped by the container after view mutations. */
  revision: number;
  /** Shared frame batcher for canvas redraws. */
  painter: Painter;
  /** Notes whose parameter values are shown. */
  notes: EditorNote[];
  /** Selected note ids. */
  selection: Set<number>;
  /** Per-note color resolver (single track color by default). */
  noteColor?: NoteColorFn;
  /** Note field shown by the bars; defaults to note-on velocity. */
  param?: LaneParamId;
  /** Inclusive source-coordinate bounds of the editable clip window. */
  minPpq?: number;
  maxPpq?: number;
  /** Disables mutations while the owning track is frozen. */
  readOnly?: boolean;
}>();

const { t } = useI18n();

const wrapper = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);

/** Unique painter layer suffix so several editors can share one painter. */
const layerId = Math.random().toString(36).slice(2, 8);

const COLORS = PIANO_ROLL_COLORS;

const paramId = computed<LaneParamId>(() => props.param ?? 'velocity');
const spec = computed(() => laneParamSpec(paramId.value));

/** In-flight value overrides per note id while a drag runs. */
const preview = shallowRef<Map<number, number> | null>(null);

let widthPx = 0;
let heightPx = 0;

/**
 * Active gesture. `uniform` drags the grabbed selection to one value (the
 * historical velocity-lane behavior), `paint` follows a single note
 * vertically and sweeps values onto every bar the pointer crosses, `line` is
 * the alt-drag ramp tool anchored at the pointer-down position.
 */
type DragState =
  | { mode: 'uniform'; targets: number[] }
  | { mode: 'paint'; lastX: number; lastValue: number; lastId: number }
  | { mode: 'line'; anchorX: number; anchorValue: number };

let drag: DragState | null = null;

/** Last pointer value of the running drag, for the corner readout. */
let dragValue: number | null = null;

function schedule(): void {
  props.painter.schedule(`velocity-lane-${layerId}`, draw);
}

/** Computes the x extent of a note's bar column in viewport px. */
function barGeometry(note: EditorNote): { x: number; w: number } {
  const x = props.range.ppqToX(note.startPpq);
  const endX = props.range.ppqToX(note.startPpq + note.durationPpq);
  return { x, w: Math.max(3, Math.min(8, endX - x - 1)) };
}

/** Bar columns of all notes in note order (topmost hit target last). */
function laneBars(): LaneBar[] {
  return props.notes.map((note) => {
    const { x, w } = barGeometry(note);
    return { id: note.id, x, w };
  });
}

function draw(): void {
  const el = canvas.value;
  if (!el || widthPx <= 0 || heightPx <= 0) return;
  const ctx = getCanvasContext(el);
  if (!ctx) return;
  const range = props.range;
  const param = paramId.value;
  const bipolar = spec.value.bipolar;

  ctx.fillStyle = COLORS.laneBackground;
  ctx.fillRect(0, 0, widthPx, heightPx);
  ctx.fillStyle = COLORS.laneRule;
  for (const fraction of [0.25, 0.5, 0.75]) {
    ctx.fillRect(0, Math.round(heightPx * fraction), widthPx, 1);
  }
  if (bipolar) {
    ctx.fillStyle = COLORS.laneCenter;
    ctx.fillRect(0, Math.round(heightPx / 2), widthPx, 1);
  }

  const colorOf = props.noteColor ?? ((): string => DEFAULT_NOTE_COLOR);
  const overrides = preview.value;
  for (const note of props.notes) {
    if (note.startPpq + note.durationPpq <= range.startPpq || note.startPpq >= range.endPpq) {
      continue;
    }
    const { x, w } = barGeometry(note);
    if (x + w < 0 || x > widthPx) continue;
    const value = overrides?.get(note.id) ?? noteLaneValue(param, note);
    const rect = laneBarRect(param, value, heightPx);
    const selected = props.selection.has(note.id);
    ctx.globalAlpha = selected ? 1 : 0.7;
    ctx.fillStyle = colorOf(note);
    ctx.fillRect(x, rect.y, w, rect.h);
    if (selected) {
      // Emphasis cap on the value end of the bar (outer edge for bipolar).
      const capY = bipolar && value < 0 ? rect.y + rect.h - 2 : rect.y;
      ctx.fillStyle = COLORS.noteSelectedBorder;
      ctx.fillRect(x, capY, w, 2);
    }
  }
  ctx.globalAlpha = 1;

  if (dragValue !== null) {
    ctx.fillStyle = COLORS.laneValueText;
    ctx.font = canvasFont(CANVAS_FONT_SIZE_PX.meta);
    ctx.fillText(formatLaneValue(param, dragValue), 6, 12);
  }
}

/** Finds the topmost note whose bar column contains the x coordinate. */
function hitBar(x: number): EditorNote | null {
  for (let i = props.notes.length - 1; i >= 0; i--) {
    const note = props.notes[i];
    const { x: barX, w } = barGeometry(note);
    if (x >= barX && x <= barX + w) return note;
  }
  return null;
}

function localPoint(event: PointerEvent): { x: number; y: number } {
  const rect = wrapper.value?.getBoundingClientRect();
  return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
}

/**
 * Paint step: bars crossed since the last move get values interpolated along
 * the pointer path, then the bar under the pointer (or the last touched one,
 * so plain vertical drags keep following) tracks the pointer value exactly.
 */
function applyPaint(state: Extract<DragState, { mode: 'paint' }>, x: number, value: number): void {
  const param = paramId.value;
  const next = new Map(preview.value ?? []);
  for (const bar of barsInSpan(laneBars(), state.lastX, x)) {
    const ramped = rampValueAt(state.lastX, state.lastValue, x, value, bar.x + bar.w / 2);
    next.set(bar.id, quantizeLaneValue(param, ramped));
  }
  const currentId = hitBar(x)?.id ?? state.lastId;
  next.set(currentId, value);
  preview.value = next;
  state.lastX = x;
  state.lastValue = value;
  state.lastId = currentId;
}

/** Line-tool step: rebuilds the preview as a ramp from the anchor. */
function applyLine(state: Extract<DragState, { mode: 'line' }>, x: number, value: number): void {
  const param = paramId.value;
  const next = new Map<number, number>();
  for (const bar of barsInSpan(laneBars(), state.anchorX, x)) {
    const ramped = rampValueAt(state.anchorX, state.anchorValue, x, value, bar.x + bar.w / 2);
    next.set(bar.id, quantizeLaneValue(param, ramped));
  }
  preview.value = next;
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || props.readOnly) return;
  const point = localPoint(event);
  const value = laneValueFromY(paramId.value, point.y, heightPx);
  if (event.altKey) {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag = { mode: 'line', anchorX: point.x, anchorValue: value };
    dragValue = value;
    applyLine(drag, point.x, value);
    schedule();
    return;
  }
  const hit = hitBar(point.x);
  if (!hit) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  if (props.selection.has(hit.id)) {
    const targets = [...props.selection];
    drag = { mode: 'uniform', targets };
    preview.value = new Map(targets.map((id) => [id, value]));
  } else {
    setSelection([hit.id]);
    drag = { mode: 'paint', lastX: point.x, lastValue: value, lastId: hit.id };
    preview.value = new Map([[hit.id, value]]);
  }
  dragValue = value;
  schedule();
}

function onPointerMove(event: PointerEvent): void {
  if (!drag || props.readOnly) return;
  const point = localPoint(event);
  const value = laneValueFromY(paramId.value, point.y, heightPx);
  if (drag.mode === 'uniform') {
    preview.value = new Map(drag.targets.map((id) => [id, value]));
  } else if (drag.mode === 'paint') {
    applyPaint(drag, point.x, value);
  } else {
    applyLine(drag, point.x, value);
  }
  dragValue = value;
  schedule();
}

function onPointerUp(): void {
  if (!drag) return;
  if (props.readOnly) {
    onPointerCancel();
    return;
  }
  const param = paramId.value;
  const overrides = preview.value;
  drag = null;
  dragValue = null;
  preview.value = null;
  if (overrides) {
    const byId = new Map(props.notes.map((note) => [note.id, note]));
    const updates: EditorNoteUpdate[] = [];
    for (const [id, value] of overrides) {
      const note = byId.get(id);
      if (!note) continue;
      const update = laneUpdateForValue(
        param,
        note,
        value,
        props.minPpq === undefined || props.maxPpq === undefined
          ? undefined
          : { minStartPpq: props.minPpq, maxEndPpq: props.maxPpq },
      );
      if (update) updates.push(update);
    }
    if (updates.length > 0) updateNotes(updates);
  }
  schedule();
}

function onPointerCancel(): void {
  drag = null;
  dragValue = null;
  preview.value = null;
  schedule();
}

let resizeObserver: ResizeObserver | null = null;
let stopDprObserver: (() => void) | null = null;

function refreshForDevicePixelRatio(): void {
  if (widthPx <= 0 || heightPx <= 0) return;
  if (canvas.value) setupCanvas(canvas.value, widthPx, heightPx);
  schedule();
}

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
  stopDprObserver = observeDevicePixelRatio(refreshForDevicePixelRatio);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  stopDprObserver?.();
  stopDprObserver = null;
});

// Switching tabs discards any in-flight gesture preview.
watch(paramId, () => {
  drag = null;
  dragValue = null;
  preview.value = null;
});

watch(
  () => props.readOnly,
  (readOnly) => {
    if (readOnly) onPointerCancel();
  },
);

watch(
  () => [props.revision, props.notes, props.selection, paramId.value, props.noteColor] as const,
  () => schedule(),
);
</script>

<template>
  <div
    ref="wrapper"
    class="velocity-lane"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
  >
    <canvas
      ref="canvas"
      class="velocity-canvas"
      role="img"
      :aria-label="t.shell.pianoRoll.parameterLane"
    />
  </div>
</template>

<style scoped>
.velocity-lane {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: none;
  cursor: ns-resize;
}

.velocity-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
</style>
