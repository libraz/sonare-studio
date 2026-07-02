<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { formatPitch } from '@/lib/pitch';
import type { EditorNote, TimeSignatureSegment } from '@/project/types';
import { rulerTicks } from '@/ui/arrangement/ruler';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { useI18n } from '@/ui/i18n';
import { type GhostNote, hitTestGhost } from './overlay';
import {
  DEFAULT_NOTE_COLOR,
  fillRoundRect,
  getCanvasContext,
  isBlackKey,
  type NoteColorFn,
  PIANO_ROLL_COLORS,
  setupCanvas,
  strokeRoundRect,
} from './theme';
import type {
  InteractionModifiers,
  InteractionPoint,
  NoteInteractions,
} from './use-note-interactions';
import { visibleNotesInWindow } from './visible-notes';

/**
 * Scrollable/zoomable note grid canvas of the piano roll: pitch rows, beat and
 * bar gridlines, note rectangles, marquee and playhead overlay. Rendering is
 * split into background (rows/grid), note and overlay layers so common updates
 * repaint the smallest useful surface.
 */

const props = defineProps<{
  /** Shared timeline viewport (this component owns its resize). */
  range: TimelineRange;
  /** Monotonic counter bumped by the container after view mutations. */
  revision: number;
  /** Shared frame batcher for canvas redraws. */
  painter: Painter;
  /** Notes to render (store mirror; a gesture preview overrides it). */
  notes: EditorNote[];
  /** Selected note ids. */
  selection: Set<number>;
  /** Scale-highlight flags per pitch class (index 0 = C). */
  highlightedPitchClasses: boolean[];
  /** Snap grid step in PPQ (fine gridline spacing). */
  gridPpq: number;
  /** Length of the edited clip in PPQ; the region past it is shaded. */
  clipLengthPpq: number;
  /** Project time signatures for bar/beat gridlines. */
  timeSignatures: TimeSignatureSegment[];
  /** Gesture state machine shared with the container. */
  interactions: NoteInteractions;
  /** Playhead position getter in PPQ; omit to hide the playhead. */
  positionPpq?: () => number;
  /** Per-note color resolver (single track color by default). */
  noteColor?: NoteColorFn;
  /** Read-only ghost notes from non-active clips, drawn under the notes. */
  ghostNotes?: GhostNote[];
}>();

const { t } = useI18n();

const emit = defineEmits<{
  /** Fired after the grid viewport was resized and the range re-clamped. */
  'view-resize': [widthPx: number, heightPx: number];
  /** Fired when a pointer press lands on a ghost note (read-only overlay). */
  'ghost-activate': [ghost: GhostNote];
  /** Right-click on the grid: noteId is null when no note was hit. */
  'note-context': [payload: { x: number; y: number; noteId: number | null; ppq: number }];
  /** Hovered musical position for status readouts. */
  'hover-status': [payload: { ppq: number; pitch: number } | null];
}>();

const wrapper = ref<HTMLDivElement | null>(null);
const backgroundCanvas = ref<HTMLCanvasElement | null>(null);
const notesCanvas = ref<HTMLCanvasElement | null>(null);
const overlayCanvas = ref<HTMLCanvasElement | null>(null);
const hoveredGhost = ref<GhostNote | null>(null);
const hoverPoint = ref<InteractionPoint | null>(null);

/** Unique painter layer suffix so several editors can share one painter. */
const layerId = Math.random().toString(36).slice(2, 8);

const COLORS = PIANO_ROLL_COLORS;

/** Minimum px spacing before a vertical gridline family is drawn. */
const MIN_GRID_SPACING_PX = 6;
const LABEL_MIN_ROW_HEIGHT = 13;
const LABEL_MIN_NOTE_WIDTH = 26;
const SHORT_NOTE_WARNING_PPQ = 0.0625;

function scheduleBackground(): void {
  props.painter.schedule(`note-grid-background-${layerId}`, drawBackground);
}

function scheduleNotes(): void {
  props.painter.schedule(`note-grid-notes-${layerId}`, drawNotes);
}

function scheduleOverlay(): void {
  props.painter.schedule(`note-grid-overlay-${layerId}`, drawOverlay);
}

function scheduleAll(): void {
  scheduleBackground();
  scheduleNotes();
  scheduleOverlay();
}

/** Draws one family of vertical gridlines at `step` PPQ spacing. */
function drawVerticalLines(
  ctx: CanvasRenderingContext2D,
  step: number,
  color: string,
  height: number,
): void {
  if (!(step > 0) || step * props.range.pxPerPpq < MIN_GRID_SPACING_PX) return;
  ctx.fillStyle = color;
  const first = Math.ceil(props.range.startPpq / step) * step;
  for (let ppq = first; ppq < props.range.endPpq; ppq += step) {
    ctx.fillRect(Math.round(props.range.ppqToX(ppq)), 0, 1, height);
  }
}

/** Draws meter-aware beat/bar lines from the same tick model as the ruler. */
function drawMeterLines(ctx: CanvasRenderingContext2D, height: number): void {
  for (const tick of rulerTicks(
    props.timeSignatures,
    props.range.startPpq,
    props.range.endPpq,
    props.range.pxPerPpq,
    { minBeatSpacingPx: MIN_GRID_SPACING_PX, minBarLabelSpacingPx: Number.POSITIVE_INFINITY },
  )) {
    ctx.fillStyle = tick.kind === 'bar' ? COLORS.gridBar : COLORS.gridBeat;
    ctx.fillRect(Math.round(props.range.ppqToX(tick.ppq)), 0, 1, height);
  }
}

function overlappingNoteIds(notes: ReadonlyArray<EditorNote>): Set<number> {
  const byPitch = new Map<number, EditorNote[]>();
  for (const note of notes) {
    const group = byPitch.get(note.pitch);
    if (group) group.push(note);
    else byPitch.set(note.pitch, [note]);
  }

  const ids = new Set<number>();
  for (const group of byPitch.values()) {
    group.sort((a, b) => a.startPpq - b.startPpq || a.id - b.id);
    let active: EditorNote | null = null;
    let activeEnd = Number.NEGATIVE_INFINITY;
    for (const note of group) {
      const end = note.startPpq + note.durationPpq;
      if (active && note.startPpq < activeEnd) {
        ids.add(active.id);
        ids.add(note.id);
        if (end > activeEnd) {
          active = note;
          activeEnd = end;
        }
      } else {
        active = note;
        activeEnd = end;
      }
    }
  }
  return ids;
}

function hasScaleMask(): boolean {
  return props.highlightedPitchClasses.some(Boolean);
}

/** Draws background rows and gridlines. */
function drawBackground(): void {
  const canvas = backgroundCanvas.value;
  if (!canvas) return;
  const ctx = getCanvasContext(canvas);
  if (!ctx) return;
  const range = props.range;
  const w = range.widthPx;
  const h = range.heightPx;

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, w, h);

  // Pitch rows: black-key shading, scale tint and row separators.
  const lowPitch = range.yToPitch(h - 1);
  const highPitch = range.yToPitch(0);
  for (let pitch = lowPitch; pitch <= highPitch; pitch++) {
    const y = range.pitchToY(pitch);
    if (isBlackKey(pitch)) {
      ctx.fillStyle = COLORS.rowBlackKey;
      ctx.fillRect(0, y, w, range.rowHeight);
    }
    if (props.highlightedPitchClasses[((pitch % 12) + 12) % 12]) {
      ctx.fillStyle = COLORS.rowScale;
      ctx.fillRect(0, y, w, range.rowHeight);
    }
    if (range.rowHeight >= 5) {
      ctx.fillStyle = COLORS.rowLine;
      ctx.fillRect(0, y + range.rowHeight - 1, w, 1);
    }
  }

  // Vertical gridlines, finest first so stronger lines draw on top.
  if (props.gridPpq < 1) drawVerticalLines(ctx, props.gridPpq, COLORS.gridFine, h);
  drawMeterLines(ctx, h);

  // Shade the region past the clip end.
  const clipEndX = range.ppqToX(props.clipLengthPpq);
  if (clipEndX < w) {
    ctx.fillStyle = COLORS.beyondClip;
    ctx.fillRect(Math.max(0, clipEndX), 0, w - Math.max(0, clipEndX), h);
  }
}

/** Draws ghost and editable note rectangles. */
function drawNotes(): void {
  const canvas = notesCanvas.value;
  if (!canvas) return;
  const ctx = getCanvasContext(canvas);
  if (!ctx) return;
  const range = props.range;
  const w = range.widthPx;
  const h = range.heightPx;
  ctx.clearRect(0, 0, w, h);
  const lowPitch = range.yToPitch(h - 1);
  const highPitch = range.yToPitch(0);

  const viewWindow = {
    startPpq: range.startPpq,
    endPpq: range.endPpq,
    minPitch: lowPitch,
    maxPitch: highPitch,
  };
  const noteH = Math.max(2, range.rowHeight - 2);

  // Ghost notes from non-active clips draw under the editable notes.
  const visibleGhosts = visibleNotesInWindow(props.ghostNotes ?? [], viewWindow);
  for (const ghost of visibleGhosts) {
    const y = range.pitchToY(ghost.pitch);
    const x = range.ppqToX(ghost.startPpq);
    const ghostW = Math.max(2, ghost.durationPpq * range.pxPerPpq - 1);
    ctx.fillStyle = ghost.color;
    fillRoundRect(ctx, x, y + 1, ghostW, noteH, 2);
  }

  // Notes: gesture preview replaces the store mirror while dragging.
  const list = props.interactions.previewNotes.value ?? props.notes;
  const visibleNotes = visibleNotesInWindow(list, viewWindow);
  const colorOf = props.noteColor ?? ((): string => DEFAULT_NOTE_COLOR);
  const scaleMaskActive = hasScaleMask();
  const overlapIds = overlappingNoteIds(visibleNotes);
  for (const note of visibleNotes) {
    const y = range.pitchToY(note.pitch);
    const x = range.ppqToX(note.startPpq);
    const noteW = Math.max(2, note.durationPpq * range.pxPerPpq - 1);
    // Negative ids mark in-flight duplicate copies; render them as selected.
    const selected = note.id < 0 || props.selection.has(note.id);
    ctx.fillStyle = colorOf(note);
    fillRoundRect(ctx, x, y + 1, noteW, noteH, 2);
    ctx.lineWidth = selected ? 1.5 : 1;
    ctx.strokeStyle = selected ? COLORS.noteSelectedBorder : COLORS.noteBorder;
    strokeRoundRect(ctx, x + 0.5, y + 1.5, noteW - 1, noteH - 1, 2);

    const pitchClass = ((note.pitch % 12) + 12) % 12;
    const offScale = scaleMaskActive && !props.highlightedPitchClasses[pitchClass];
    const tooShort = note.durationPpq <= SHORT_NOTE_WARNING_PPQ;
    const overlap = overlapIds.has(note.id);
    if (overlap || offScale || tooShort) {
      ctx.fillStyle = overlap ? COLORS.noteError : COLORS.noteWarning;
      ctx.fillRect(x + 2, y + 2, Math.max(2, Math.min(noteW - 4, 18)), 2);
    }

    if (range.rowHeight >= LABEL_MIN_ROW_HEIGHT && noteW >= LABEL_MIN_NOTE_WIDTH) {
      ctx.fillStyle = COLORS.noteText;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(formatPitch(note.pitch), x + 5, y + range.rowHeight / 2, noteW - 8);
    }
  }
}

/** Draws the marquee rectangle and the playhead line. */
function drawOverlay(): void {
  const canvas = overlayCanvas.value;
  if (!canvas) return;
  const ctx = getCanvasContext(canvas);
  if (!ctx) return;
  const w = props.range.widthPx;
  const h = props.range.heightPx;
  ctx.clearRect(0, 0, w, h);

  const m = props.interactions.marquee.value;
  if (m) {
    const x = Math.min(m.x, m.x + m.width);
    const y = Math.min(m.y, m.y + m.height);
    const mw = Math.abs(m.width);
    const mh = Math.abs(m.height);
    ctx.fillStyle = COLORS.marqueeFill;
    ctx.fillRect(x, y, mw, mh);
    ctx.strokeStyle = COLORS.marqueeStroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, mw, mh);
  }

  const readout = props.interactions.gestureReadout?.value ?? null;
  if (readout) {
    ctx.font = '11px system-ui, sans-serif';
    const paddingX = 7;
    const paddingY = 4;
    const metrics = ctx.measureText(readout.text);
    const boxW = metrics.width + paddingX * 2;
    const boxH = 20;
    const x = Math.min(Math.max(4, readout.x), w - boxW - 4);
    const y = Math.min(Math.max(4, readout.y), h - boxH - 4);
    ctx.fillStyle = COLORS.hudBackground;
    fillRoundRect(ctx, x, y, boxW, boxH, 4);
    ctx.fillStyle = COLORS.hudText;
    ctx.textBaseline = 'middle';
    ctx.fillText(readout.text, x + paddingX, y + boxH / 2 + paddingY * 0.05);
  }

  const ghost = hoveredGhost.value;
  if (ghost) {
    const x = props.range.ppqToX(ghost.startPpq);
    const y = props.range.pitchToY(ghost.pitch);
    const ghostW = Math.max(2, ghost.durationPpq * props.range.pxPerPpq - 1);
    const noteH = Math.max(2, props.range.rowHeight - 2);
    ctx.strokeStyle = COLORS.noteSelectedBorder;
    ctx.lineWidth = 1.5;
    strokeRoundRect(ctx, x + 0.5, y + 1.5, ghostW - 1, noteH - 1, 2);
    const text = `${ghost.trackName} · ${formatPitch(ghost.pitch)}`;
    ctx.font = '11px system-ui, sans-serif';
    const boxW = ctx.measureText(text).width + 14;
    const boxH = 20;
    const labelX = Math.min(Math.max(4, x + 8), w - boxW - 4);
    const labelY = Math.min(Math.max(4, y - 22), h - boxH - 4);
    ctx.fillStyle = COLORS.hudBackground;
    fillRoundRect(ctx, labelX, labelY, boxW, boxH, 4);
    ctx.fillStyle = COLORS.hudText;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, labelX + 7, labelY + boxH / 2);
  }

  const guide = hoverPoint.value;
  if (guide) {
    ctx.strokeStyle = COLORS.rulerBeat;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(guide.x) + 0.5, 0);
    ctx.lineTo(Math.round(guide.x) + 0.5, h);
    ctx.moveTo(0, Math.round(guide.y) + 0.5);
    ctx.lineTo(w, Math.round(guide.y) + 0.5);
    ctx.stroke();
  }

  if (props.positionPpq) {
    const x = props.range.ppqToX(props.positionPpq());
    if (x >= 0 && x <= w) {
      ctx.fillStyle = COLORS.playhead;
      ctx.fillRect(Math.round(x), 0, 1.5, h);
    }
  }
}

// Playhead polling: redraw the overlay only when the playhead px moved.
let playheadRaf: number | null = null;
let lastPlayheadX = Number.NaN;

function playheadTick(): void {
  const getter = props.positionPpq;
  if (getter) {
    const x = props.range.ppqToX(getter());
    if (x !== lastPlayheadX) {
      lastPlayheadX = x;
      scheduleOverlay();
    }
  }
  playheadRaf = requestAnimationFrame(playheadTick);
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  const el = wrapper.value;
  if (!el) return;
  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    const w = entry.contentRect.width;
    const h = entry.contentRect.height;
    if (w <= 0 || h <= 0) return;
    props.range.resize(w, h);
    if (backgroundCanvas.value) setupCanvas(backgroundCanvas.value, w, h);
    if (notesCanvas.value) setupCanvas(notesCanvas.value, w, h);
    if (overlayCanvas.value) setupCanvas(overlayCanvas.value, w, h);
    emit('view-resize', w, h);
    scheduleAll();
  });
  resizeObserver.observe(el);
  playheadRaf = requestAnimationFrame(playheadTick);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (playheadRaf !== null) cancelAnimationFrame(playheadRaf);
});

watch(
  () => [
    props.revision,
    props.highlightedPitchClasses,
    props.gridPpq,
    props.clipLengthPpq,
    props.timeSignatures,
  ],
  () => {
    lastPlayheadX = Number.NaN;
    scheduleBackground();
    scheduleNotes();
    scheduleOverlay();
  },
);

watch(
  () => [props.notes, props.ghostNotes, props.noteColor, props.interactions.previewNotes.value],
  () => {
    scheduleNotes();
    scheduleOverlay();
  },
);

watch(
  () => props.selection,
  () => {
    scheduleNotes();
  },
);

watch(
  () =>
    [
      props.interactions.marquee.value,
      props.interactions.gestureReadout?.value ?? null,
      hoveredGhost.value,
      hoverPoint.value,
    ] as const,
  () => scheduleOverlay(),
);

function localPoint(event: MouseEvent): InteractionPoint {
  const rect = wrapper.value?.getBoundingClientRect();
  return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
}

function modifiers(event: MouseEvent): InteractionModifiers {
  return { shift: event.shiftKey, alt: event.altKey, meta: event.metaKey || event.ctrlKey };
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  const point = localPoint(event);
  const mods = modifiers(event);
  // A press on a ghost note requests track/clip activation instead of an
  // editing gesture; alt keeps the current track and edits normally.
  if (!mods.alt) {
    const ghost = hitTestGhost(props.notes, props.ghostNotes ?? [], point, props.range);
    if (ghost) {
      emit('ghost-activate', ghost);
      return;
    }
  }
  props.interactions.onPointerDown(point, mods);
}

function onPointerMove(event: PointerEvent): void {
  const point = localPoint(event);
  const mods = modifiers(event);
  hoveredGhost.value = mods.alt
    ? null
    : hitTestGhost(props.notes, props.ghostNotes ?? [], point, props.range);
  hoverPoint.value = point;
  emit('hover-status', {
    ppq: Math.max(0, props.range.xToPpq(point.x)),
    pitch: props.range.yToPitch(point.y),
  });
  props.interactions.onPointerMove(point, mods);
}

function onPointerUp(event: PointerEvent): void {
  if (event.button !== 0) return;
  props.interactions.onPointerUp(localPoint(event), modifiers(event));
}

function onPointerCancel(): void {
  hoveredGhost.value = null;
  hoverPoint.value = null;
  emit('hover-status', null);
  props.interactions.cancel();
}

function onPointerLeave(): void {
  hoveredGhost.value = null;
  hoverPoint.value = null;
  emit('hover-status', null);
  scheduleOverlay();
}

function onDoubleClick(event: MouseEvent): void {
  props.interactions.onDoubleClick(localPoint(event), modifiers(event));
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault();
  const point = localPoint(event);
  emit('note-context', {
    x: event.clientX,
    y: event.clientY,
    noteId: props.interactions.hitNoteAt(point),
    ppq: Math.max(0, props.range.xToPpq(point.x)),
  });
}
</script>

<template>
  <div
    ref="wrapper"
    class="note-grid"
    :style="{ cursor: props.interactions.cursor.value }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @pointerleave="onPointerLeave"
    @dblclick="onDoubleClick"
    @contextmenu="onContextMenu"
  >
    <canvas
      ref="backgroundCanvas"
      class="note-grid-layer"
      role="img"
      :aria-label="t.shell.pianoRoll.noteGrid"
    />
    <canvas ref="notesCanvas" class="note-grid-layer" aria-hidden="true" />
    <canvas ref="overlayCanvas" class="note-grid-layer" aria-hidden="true" />
  </div>
</template>

<style scoped>
.note-grid {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: none;
}

.note-grid-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
</style>
