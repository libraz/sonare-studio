<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  addNote,
  deleteNotes,
  redo,
  setActiveClip,
  setActiveTrack,
  setSelection,
  undo,
  updateNotes,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { createPainter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';
import KeyboardColumn from './KeyboardColumn.vue';
import NoteGridCanvas from './NoteGridCanvas.vue';
import { buildGhostNotes, contentCenterPitch, type GhostNote } from './overlay';
import { DEFAULT_NOTE_COLOR, type NoteColorFn } from './theme';
import { useNoteInteractions } from './use-note-interactions';
import VelocityLane from './VelocityLane.vue';

/**
 * Piano roll editor: fixed keyboard column on the left, scrollable/zoomable
 * note grid in the center, velocity lane at the bottom and minimal custom
 * scrollbars, all sharing one TimelineRange so they pan and zoom together.
 *
 * All note edits go through src/project/commands.ts; the project store is the
 * read model. The optional `positionPpq` getter drives the playhead.
 *
 * The grid edits the active clip and can overlay the other clips' notes as
 * read-only ghosts in their track colors; clicking a ghost activates its
 * track and clip (alt-click keeps the current track). The overlay toggle and
 * a track-color legend live in a slim bar above the grid.
 */

const props = defineProps<{
  /** Playhead position getter in PPQ; omit to hide the playhead. */
  positionPpq?: () => number;
}>();

const store = useProjectStore();

/** Initialization/runtime error surfaced above the editor. */
const error = ref('');

/** Default horizontal zoom in px per quarter note. */
const DEFAULT_PX_PER_PPQ = 60;
/** Default pitch row height in px. */
const DEFAULT_ROW_HEIGHT = 14;
/** Pitch placed near the vertical center on first layout (C5). */
const INITIAL_CENTER_PITCH = 72;
/** Wheel-to-zoom sensitivity for ⌘wheel / pinch gestures. */
const ZOOM_WHEEL_SENSITIVITY = 0.0035;

// The TimelineRange and painter are plain (non-reactive) objects; views are
// invalidated through the `revision` counter after every range mutation.
const range = markRaw(
  new TimelineRange({
    widthPx: 1,
    heightPx: 1,
    pxPerPpq: DEFAULT_PX_PER_PPQ,
    rowHeight: DEFAULT_ROW_HEIGHT,
  }),
);
const painter = markRaw(createPainter());

/** Bumped after any TimelineRange mutation to trigger canvas redraws. */
const revision = ref(0);

function bump(): void {
  revision.value++;
}

/** Snap grid step in PPQ derived from the store's divisions-per-whole-note. */
const gridPpq = computed(() => 4 / store.snapDivision);

/** Whether the multi-track ghost overlay is drawn. */
const overlayEnabled = ref(true);

/** Read-only ghost notes from all non-active clips (empty when overlay off). */
const ghostNotes = computed<GhostNote[]>(() =>
  overlayEnabled.value
    ? buildGhostNotes({
        clips: store.clips,
        tracks: store.tracks,
        activeClipId: store.clipId,
      })
    : [],
);

/**
 * Color resolver for the editable notes: the active track's color at full
 * saturation. A new function identity per color change keeps the grid's
 * redraw watcher firing.
 */
const noteColor = computed<NoteColorFn>(() => {
  const color = store.activeTrack?.color ?? DEFAULT_NOTE_COLOR;
  return () => color;
});

/** Activates a ghost note's track + clip and selects that note. */
function onGhostActivate(ghost: GhostNote): void {
  setActiveClip(ghost.clipId);
  setSelection([ghost.noteId]);
}

/** Legend chip click: focuses the track (activates its first clip, if any). */
function onLegendClick(trackId: number): void {
  // Re-clicking the active track keeps the currently active clip.
  if (trackId === store.activeTrackId) return;
  setActiveTrack(trackId);
}

const interactions = useNoteInteractions({
  view: range,
  getNotes: () => store.notes,
  getSelection: () => store.selection,
  // A non-positive step disables snapping in the gesture state machine while
  // the drawn gridlines keep following the configured division.
  getGridPpq: () => (store.snapEnabled ? gridPpq.value : 0),
  commands: { addNote, updateNotes, deleteNotes, setSelection },
});

const root = ref<HTMLDivElement | null>(null);
const gridCell = ref<HTMLDivElement | null>(null);
const hTrack = ref<HTMLDivElement | null>(null);
const vTrack = ref<HTMLDivElement | null>(null);

let initialScrollDone = false;

/** Centers the view on middle-register pitches after the first layout pass. */
function onGridResize(): void {
  if (!initialScrollDone && range.heightPx > 1) {
    initialScrollDone = true;
    const rowTop = (127 - INITIAL_CENTER_PITCH) * range.rowHeight;
    range.setScrollY(rowTop - range.heightPx / 2);
  }
  bump();
}

/** Re-centers the view vertically on the active clip's note content. */
function centerOnActiveClip(): void {
  if (range.heightPx <= 1) return;
  const center = contentCenterPitch(store.notes);
  if (center === null) return;
  const rowTop = (127 - center) * range.rowHeight;
  range.setScrollY(rowTop + range.rowHeight / 2 - range.heightPx / 2);
  bump();
}

// Follow active-clip switches: re-center vertically on the new content while
// preserving the horizontal scroll position.
watch(
  () => store.clipId,
  () => centerOnActiveClip(),
);

/** Total horizontal content extent in PPQ (clip length, notes and view). */
function contentPpq(): number {
  let maxEnd = store.clipLengthPpq;
  for (const note of store.notes) {
    maxEnd = Math.max(maxEnd, note.startPpq + note.durationPpq);
  }
  return Math.max(maxEnd, range.endPpq);
}

function onWheel(event: WheelEvent): void {
  const anchorEl = gridCell.value;
  if (!anchorEl) return;
  if (event.metaKey || event.ctrlKey) {
    const anchorX = event.clientX - anchorEl.getBoundingClientRect().left;
    range.zoomAt(anchorX, Math.exp(-event.deltaY * ZOOM_WHEEL_SENSITIVITY));
  } else if (event.shiftKey) {
    range.scrollByPx(event.deltaY + event.deltaX);
  } else {
    range.scrollByPx(event.deltaX);
    range.scrollByY(event.deltaY);
  }
  bump();
}

function onKeyDown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (interactions.onKeyDown(event.key)) event.preventDefault();
}

/** Focuses the editor so keyboard shortcuts work after any click inside it. */
function onRootPointerDown(): void {
  root.value?.focus();
}

// --- Scrollbars -----------------------------------------------------------

interface ScrollDrag {
  axis: 'h' | 'v';
  startClient: number;
  startValue: number;
  contentSize: number;
  trackPx: number;
  spanPpq: number;
}

let scrollDrag: ScrollDrag | null = null;

const vThumbStyle = computed(() => {
  void revision.value;
  const content = Math.max(1, range.contentHeightPx);
  const sizePct = Math.max(4, Math.min(100, (range.heightPx / content) * 100));
  const topPct = Math.min(100 - sizePct, (range.scrollY / content) * 100);
  return { top: `${topPct}%`, height: `${sizePct}%` };
});

const hThumbStyle = computed(() => {
  void revision.value;
  // Track the store notes so the thumb resizes when content grows.
  void store.notes;
  const content = Math.max(1e-6, contentPpq());
  const span = range.endPpq - range.startPpq;
  const sizePct = Math.max(4, Math.min(100, (span / content) * 100));
  const leftPct = Math.min(100 - sizePct, (range.startPpq / content) * 100);
  return { left: `${leftPct}%`, width: `${sizePct}%` };
});

function onVScrollDown(event: PointerEvent): void {
  const track = vTrack.value;
  if (!track || event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  scrollDrag = {
    axis: 'v',
    startClient: event.clientY,
    startValue: range.scrollY,
    contentSize: range.contentHeightPx,
    trackPx: Math.max(1, track.clientHeight),
    spanPpq: 0,
  };
}

function onHScrollDown(event: PointerEvent): void {
  const track = hTrack.value;
  if (!track || event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  scrollDrag = {
    axis: 'h',
    startClient: event.clientX,
    startValue: range.startPpq,
    contentSize: contentPpq(),
    trackPx: Math.max(1, track.clientWidth),
    spanPpq: range.endPpq - range.startPpq,
  };
}

function onScrollMove(event: PointerEvent): void {
  const drag = scrollDrag;
  if (!drag) return;
  if (drag.axis === 'v') {
    const dy = event.clientY - drag.startClient;
    range.setScrollY(drag.startValue + (dy * drag.contentSize) / drag.trackPx);
  } else {
    const dx = event.clientX - drag.startClient;
    const target = drag.startValue + (dx * drag.contentSize) / drag.trackPx;
    range.setStartPpq(Math.min(target, drag.contentSize - drag.spanPpq));
  }
  bump();
}

function onScrollUp(): void {
  scrollDrag = null;
}

onMounted(async () => {
  try {
    await store.init();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
});

onBeforeUnmount(() => {
  painter.dispose();
});
</script>

<template>
  <div
    ref="root"
    class="piano-roll-editor"
    tabindex="0"
    @keydown="onKeyDown"
    @wheel.prevent="onWheel"
    @pointerdown="onRootPointerDown"
  >
    <p v-if="error" class="piano-roll-error" role="alert">{{ error }}</p>
    <div class="roll-toolbar">
      <label class="overlay-toggle">
        <input v-model="overlayEnabled" type="checkbox" />
        Overlay
      </label>
      <div class="track-legend">
        <button
          v-for="track in store.tracks"
          :key="track.id"
          type="button"
          class="legend-chip"
          :class="{ 'legend-chip-active': track.id === store.activeTrackId }"
          :title="track.name"
          @click="onLegendClick(track.id)"
        >
          <span class="chip-swatch" :style="{ background: track.color }" />
          <span class="chip-name">{{ track.name }}</span>
        </button>
      </div>
    </div>
    <div class="piano-roll-layout">
      <KeyboardColumn class="cell-keyboard" :range="range" :revision="revision" :painter="painter" />
      <div ref="gridCell" class="cell-grid">
        <NoteGridCanvas
          :range="range"
          :revision="revision"
          :painter="painter"
          :notes="store.notes"
          :selection="store.selection"
          :highlighted-pitch-classes="store.highlightedPitchClasses"
          :grid-ppq="gridPpq"
          :clip-length-ppq="store.clipLengthPpq"
          :interactions="interactions"
          :position-ppq="props.positionPpq"
          :note-color="noteColor"
          :ghost-notes="ghostNotes"
          @view-resize="onGridResize"
          @ghost-activate="onGhostActivate"
        />
      </div>
      <div
        ref="vTrack"
        class="cell-vscroll scroll-track scroll-track-v"
        @pointerdown="onVScrollDown"
        @pointermove="onScrollMove"
        @pointerup="onScrollUp"
        @pointercancel="onScrollUp"
      >
        <div class="scroll-thumb scroll-thumb-v" :style="vThumbStyle" />
      </div>
      <div class="cell-velocity-label">VEL</div>
      <VelocityLane
        class="cell-velocity"
        :range="range"
        :revision="revision"
        :painter="painter"
        :notes="store.notes"
        :selection="store.selection"
      />
      <div class="cell-corner" />
      <div class="cell-hscroll-spacer" />
      <div
        ref="hTrack"
        class="cell-hscroll scroll-track scroll-track-h"
        @pointerdown="onHScrollDown"
        @pointermove="onScrollMove"
        @pointerup="onScrollUp"
        @pointercancel="onScrollUp"
      >
        <div class="scroll-thumb scroll-thumb-h" :style="hThumbStyle" />
      </div>
      <div class="cell-corner-br" />
    </div>
  </div>
</template>

<style scoped>
.piano-roll-editor {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 240px;
  background: #101216;
  color: #c8cdd6;
  outline: none;
}

.piano-roll-editor:focus-visible {
  box-shadow: inset 0 0 0 1px rgba(96, 165, 250, 0.6);
}

.piano-roll-error {
  margin: 0;
  padding: 0.5rem 0.75rem;
  background: #3b1219;
  color: #ffb4b4;
  font: 12px/1.4 system-ui, sans-serif;
}

.roll-toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.25rem 0.5rem;
  background: #14161b;
  border-bottom: 1px solid rgba(0, 0, 0, 0.4);
  font: 12px/1.4 system-ui, sans-serif;
}

.overlay-toggle {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  white-space: nowrap;
  cursor: pointer;
  color: #9aa1ad;
}

.track-legend {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  overflow-x: auto;
}

.legend-chip {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.1rem 0.45rem;
  border: 1px solid transparent;
  border-radius: 9999px;
  background: transparent;
  color: #9aa1ad;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}

.legend-chip:hover {
  background: #1c1f26;
}

.legend-chip-active {
  border-color: #3a4150;
  background: #1c1f26;
  color: #e2e6ed;
}

.chip-swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: none;
}

.chip-name {
  max-width: 9rem;
  overflow: hidden;
  text-overflow: ellipsis;
}

.piano-roll-layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 72px 1fr 12px;
  grid-template-rows: 1fr 96px 12px;
}

.cell-keyboard {
  grid-area: 1 / 1;
}

.cell-grid {
  grid-area: 1 / 2;
  position: relative;
  min-width: 0;
  min-height: 0;
}

.cell-vscroll {
  grid-area: 1 / 3;
}

.cell-velocity-label {
  grid-area: 2 / 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font: 600 10px system-ui, sans-serif;
  letter-spacing: 0.08em;
  color: #5b6270;
  background: #181a20;
  border-top: 1px solid rgba(0, 0, 0, 0.4);
}

.cell-velocity {
  grid-area: 2 / 2;
  border-top: 1px solid rgba(0, 0, 0, 0.4);
}

.cell-corner {
  grid-area: 2 / 3;
  background: #14161b;
}

.cell-hscroll-spacer {
  grid-area: 3 / 1;
  background: #14161b;
}

.cell-hscroll {
  grid-area: 3 / 2;
}

.cell-corner-br {
  grid-area: 3 / 3;
  background: #14161b;
}

.scroll-track {
  position: relative;
  background: #14161b;
  touch-action: none;
}

.scroll-thumb {
  position: absolute;
  background: #3a4150;
  border-radius: 4px;
}

.scroll-thumb:hover {
  background: #4a5263;
}

.scroll-thumb-v {
  left: 2px;
  right: 2px;
}

.scroll-thumb-h {
  top: 2px;
  bottom: 2px;
}
</style>
