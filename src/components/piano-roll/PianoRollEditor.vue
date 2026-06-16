<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useEditorTool } from '@/composables/useEditorTool';
import {
  addNote,
  deleteNotes,
  humanizeSelectionVelocity,
  quantizeSelection,
  quantizeSelectionLengths,
  redo,
  setActiveClip,
  setActiveTrack,
  setClipCcLane,
  setClipChannelPressure,
  setClipPitchBend,
  setSelection,
  snapSelectionToScale,
  splitNote,
  transposeSelection,
  undo,
  updateNotes,
} from '@/project/commands';
import {
  MIDI_PITCH_BEND_CENTER,
  MIDI_PITCH_BEND_MAX,
  PIANO_ROLL_CC_LANES,
} from '@/project/midi-cc';
import { useProjectStore } from '@/project/store';
import type { ClipCcPoint, ClipPitchBendPoint, ClipPressurePoint } from '@/project/types';
import { createPainter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';
import { useI18n } from '@/ui/i18n';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';
import BreakpointLane from './BreakpointLane.vue';
import { createNoteExtentCache } from './content-extent';
import KeyboardColumn from './KeyboardColumn.vue';
import { LANE_PARAMS, type LaneParamId } from './lane-params';
import MidiFxPanel from './MidiFxPanel.vue';
import NoteGridCanvas from './NoteGridCanvas.vue';
import { buildGhostNotes, contentCenterPitch, type GhostNote } from './overlay';
import { DEFAULT_NOTE_COLOR, type NoteColorFn } from './theme';
import { useNoteInteractions } from './use-note-interactions';
import VelocityLane from './VelocityLane.vue';

/**
 * Piano roll editor: fixed keyboard column on the left, scrollable/zoomable
 * note grid in the center, a multi-parameter note lane at the bottom
 * (velocity / length / start offset / off-velocity / channel, switched by the
 * tab strip in the lane header) and minimal custom scrollbars, all sharing
 * one TimelineRange so they pan and zoom together.
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
  /**
   * Audible-feedback hook: plays a short preview of a note's pitch/velocity
   * when one is clicked or created. Omit to edit silently.
   */
  audition?: (pitch: number, velocity: number) => void;
}>();

const store = useProjectStore();
const { t } = useI18n();

/** Initialization/runtime error surfaced above the editor. */
const error = ref('');

/** Default horizontal zoom in px per quarter note (zoomed out for an overview). */
const DEFAULT_PX_PER_PPQ = 38;
/** Default pitch row height in px (compact so more of the range is visible). */
const DEFAULT_ROW_HEIGHT = 10;
/** Pitch placed near the vertical center on first layout (C5). */
const INITIAL_CENTER_PITCH = 72;
/** Wheel-to-zoom sensitivity for ⌘wheel / pinch gestures. */
const ZOOM_WHEEL_SENSITIVITY = 0.0035;
/** Per-click zoom multiplier for the toolbar zoom buttons. */
const ZOOM_BUTTON_STEP = 1.2;
/** Row-height bounds for vertical zoom (px). */
const MIN_ROW_HEIGHT = 5;
const MAX_ROW_HEIGHT = 40;

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

/** Note parameter shown in the bottom lane (tab strip in the lane header). */
const laneParam = ref<LaneParamId>('velocity');

/**
 * Active CC controller in the bottom lane, or null when a note-parameter lane
 * is shown. When set, the bottom lane edits the active clip's CC breakpoints
 * for this controller instead of per-note values.
 */
const laneCc = ref<number | null>(null);

/** Whether the bottom lane edits the active clip's pitch-bend curve. */
const lanePitchBend = ref(false);

/** Whether the bottom lane edits the active clip's channel-pressure curve. */
const laneChannelPressure = ref(false);

/** Switches the bottom lane to a note-parameter view. */
function selectNoteLane(id: LaneParamId): void {
  laneParam.value = id;
  laneCc.value = null;
  lanePitchBend.value = false;
  laneChannelPressure.value = false;
}

/** Switches the bottom lane to a CC controller view. */
function selectCcLane(controller: number): void {
  laneCc.value = controller;
  lanePitchBend.value = false;
  laneChannelPressure.value = false;
}

/** Switches the bottom lane to the pitch-bend view. */
function selectPitchBendLane(): void {
  lanePitchBend.value = true;
  laneCc.value = null;
  laneChannelPressure.value = false;
}

/** Switches the bottom lane to the channel-pressure (aftertouch) view. */
function selectChannelPressureLane(): void {
  laneChannelPressure.value = true;
  laneCc.value = null;
  lanePitchBend.value = false;
}

/** True when a note-parameter lane (not CC/bend/pressure) is shown. */
const noteLaneActive = computed(
  () => laneCc.value === null && !lanePitchBend.value && !laneChannelPressure.value,
);

/** Active clip color for the CC curve. */
const trackColor = computed(() => store.activeTrack?.color ?? DEFAULT_NOTE_COLOR);

/** Whether the MIDI-FX transform popover is open. */
const fxPanelOpen = ref(false);

/** True when a MIDI clip is active and can receive a transform. */
const canTransform = computed(
  () => store.clipId >= 0 && (store.activeClip?.kind ?? 'midi') === 'midi',
);

/** Toggles the transform popover (closing it when no MIDI clip is active). */
function toggleFxPanel(): void {
  if (!canTransform.value) return;
  fxPanelOpen.value = !fxPanelOpen.value;
}

/** Breakpoints of the active clip's selected CC lane (empty when none). */
const activeCcPoints = computed<ClipCcPoint[]>(() => {
  if (laneCc.value === null) return [];
  const lane = store.activeClip?.ccLanes?.find((l) => l.controller === laneCc.value);
  return lane?.points ?? [];
});

/** Breakpoints of the active clip's pitch-bend lane on channel 0 (empty when none). */
const activePitchBendPoints = computed<ClipPitchBendPoint[]>(() => {
  if (!lanePitchBend.value) return [];
  const lane = store.activeClip?.pitchBendLanes?.find((l) => l.channel === 0);
  return lane?.points ?? [];
});

/** Breakpoints of the active clip's channel-pressure lane on channel 0 (empty when none). */
const activeChannelPressurePoints = computed<ClipPressurePoint[]>(() => {
  if (!laneChannelPressure.value) return [];
  const lane = store.activeClip?.channelPressureLanes?.find((l) => l.channel === 0);
  return lane?.points ?? [];
});

/** Commits a CC lane edit for the active controller on channel 0. */
function commitCcPoints(points: ClipCcPoint[]): void {
  if (laneCc.value === null) return;
  setClipCcLane(store.clipId, laneCc.value, 0, points);
}

/** Commits a pitch-bend lane edit on channel 0. */
function commitPitchBendPoints(points: ClipPitchBendPoint[]): void {
  setClipPitchBend(store.clipId, 0, points);
}

/** Commits a channel-pressure lane edit on channel 0. */
function commitChannelPressurePoints(points: ClipPressurePoint[]): void {
  setClipChannelPressure(store.clipId, 0, points);
}

/** Horizontal snap for lane points, following the grid when snapping is on. */
function ccSnap(ppq: number): number {
  if (!store.snapEnabled) return ppq;
  const step = gridPpq.value;
  return step > 0 ? Math.round(ppq / step) * step : ppq;
}

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

/** Maximum per-note random velocity jitter applied by the Humanize action. */
const HUMANIZE_VELOCITY_AMOUNT = 12;

/** Selection-wide note operations shared by the note and empty-space menus. */
function selectionOpItems(): ContextMenuItem[] {
  return [
    {
      id: 'quantize',
      label: t.value.shell.pianoRoll.context.quantizeStarts,
      hint: 'Q',
      run: () => quantizeSelection(),
    },
    {
      id: 'quantize-len',
      label: t.value.shell.pianoRoll.context.quantizeLengths,
      run: () => quantizeSelectionLengths(),
    },
    {
      id: 'transpose-up',
      label: t.value.shell.pianoRoll.context.transposeUpOctave,
      hint: '⇧⌘↑',
      run: () => transposeSelection(12),
    },
    {
      id: 'transpose-down',
      label: t.value.shell.pianoRoll.context.transposeDownOctave,
      hint: '⇧⌘↓',
      run: () => transposeSelection(-12),
    },
    {
      id: 'humanize',
      label: t.value.shell.pianoRoll.context.humanizeVelocity,
      run: () => humanizeSelectionVelocity(HUMANIZE_VELOCITY_AMOUNT),
    },
    {
      id: 'snap-scale',
      label: t.value.shell.pianoRoll.context.snapToScale,
      run: () => snapSelectionToScale(),
    },
  ];
}

/** Builds and opens the right-click menu for a note (or empty grid space). */
function onNoteContext(payload: {
  x: number;
  y: number;
  noteId: number | null;
  ppq: number;
}): void {
  const items: ContextMenuItem[] = [];
  if (payload.noteId !== null) {
    const note = store.notes.find((n) => n.id === payload.noteId);
    if (note) {
      if (!store.selection.has(note.id)) setSelection([note.id]);
      const step = store.snapEnabled ? gridPpq.value : 0;
      const splitPpq = step > 0 ? Math.round(payload.ppq / step) * step : payload.ppq;
      const canSplit = splitPpq > note.startPpq && splitPpq < note.startPpq + note.durationPpq;
      items.push(
        {
          id: 'split',
          label: t.value.shell.pianoRoll.context.splitHere,
          hint: '3',
          disabled: !canSplit,
          run: () => setSelection([splitNote(note.id, splitPpq)]),
        },
        ...selectionOpItems(),
        { id: 'sep-1', separator: true },
        {
          id: 'delete',
          label: t.value.shell.pianoRoll.context.delete,
          danger: true,
          hint: 'Del',
          run: () => deleteNotes([note.id]),
        },
      );
    }
  } else if (store.selection.size > 0) {
    items.push(...selectionOpItems());
  }
  openContextMenu(payload.x, payload.y, items);
}

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

const { tool } = useEditorTool();

const interactions = useNoteInteractions({
  view: range,
  getNotes: () => store.notes,
  getSelection: () => store.selection,
  // A non-positive step disables snapping in the gesture state machine while
  // the drawn gridlines keep following the configured division.
  getGridPpq: () => (store.snapEnabled ? gridPpq.value : 0),
  getTool: () => tool.value,
  commands: { addNote, updateNotes, deleteNotes, setSelection, splitNote },
  ...(props.audition ? { onAudition: props.audition } : {}),
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
  () => {
    centerOnActiveClip();
    // A transform targets a specific clip; close the popover on clip change.
    fxPanelOpen.value = false;
  },
);

/** Extent of the note content, cached per note-mirror identity. */
const noteExtentPpq = createNoteExtentCache();

/** Total horizontal content extent in PPQ (clip length, notes and view). */
function contentPpq(): number {
  return Math.max(store.clipLengthPpq, noteExtentPpq(store.notes), range.endPpq);
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

/** Zooms the timeline horizontally around the viewport center. */
function zoomHorizontal(factor: number): void {
  range.zoomAt(range.widthPx / 2, factor);
  bump();
}

/** Zooms the pitch rows vertically, keeping the viewport center pitch in place. */
function zoomVertical(factor: number): void {
  const centerRow = (range.scrollY + range.heightPx / 2) / range.rowHeight;
  const next = Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, range.rowHeight * factor));
  range.setRowHeight(next);
  range.setScrollY(centerRow * range.rowHeight - range.heightPx / 2);
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
    :aria-label="t.shell.pianoRoll.editor"
    @keydown="onKeyDown"
    @wheel.prevent="onWheel"
    @pointerdown="onRootPointerDown"
  >
    <p v-if="error" class="piano-roll-error" role="alert">{{ error }}</p>
    <div class="roll-toolbar">
      <label class="overlay-toggle">
        <input v-model="overlayEnabled" type="checkbox" />
        {{ t.shell.pianoRoll.overlay }}
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
      <div class="zoom-cluster" role="group" :aria-label="t.shell.pianoRoll.zoom">
        <span class="zoom-pair">
          <button
            type="button"
            class="zoom-btn"
            :title="t.shell.pianoRoll.zoomOutTimeTitle"
            :aria-label="t.shell.pianoRoll.zoomOutHorizontal"
            @click="zoomHorizontal(1 / ZOOM_BUTTON_STEP)"
          >
            ↔−
          </button>
          <button
            type="button"
            class="zoom-btn"
            :title="t.shell.pianoRoll.zoomInTimeTitle"
            :aria-label="t.shell.pianoRoll.zoomInHorizontal"
            @click="zoomHorizontal(ZOOM_BUTTON_STEP)"
          >
            ↔+
          </button>
        </span>
        <span class="zoom-pair">
          <button
            type="button"
            class="zoom-btn"
            :title="t.shell.pianoRoll.zoomOutPitchTitle"
            :aria-label="t.shell.pianoRoll.zoomOutVertical"
            @click="zoomVertical(1 / ZOOM_BUTTON_STEP)"
          >
            ↕−
          </button>
          <button
            type="button"
            class="zoom-btn"
            :title="t.shell.pianoRoll.zoomInPitchTitle"
            :aria-label="t.shell.pianoRoll.zoomInVertical"
            @click="zoomVertical(ZOOM_BUTTON_STEP)"
          >
            ↕+
          </button>
        </span>
      </div>
      <button
        type="button"
        class="fx-toggle"
        :class="{ 'fx-toggle-active': fxPanelOpen }"
        :disabled="!canTransform"
        :aria-expanded="fxPanelOpen"
        :title="t.shell.pianoRoll.midiFxTitle"
        @click="toggleFxPanel"
      >
        {{ t.shell.pianoRoll.midiFx }}
      </button>
      <MidiFxPanel
        v-if="fxPanelOpen && canTransform"
        :clip-id="store.clipId"
        @close="fxPanelOpen = false"
      />
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
          @note-context="onNoteContext"
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
      <div
        class="cell-velocity-label"
        role="tablist"
        :aria-label="t.shell.pianoRoll.noteLaneParameter"
      >
        <button
          v-for="laneSpec in LANE_PARAMS"
          :key="laneSpec.id"
          type="button"
          class="lane-tab"
          :class="{ 'lane-tab-active': noteLaneActive && laneParam === laneSpec.id }"
          :title="laneSpec.title"
          role="tab"
          :aria-selected="noteLaneActive && laneParam === laneSpec.id"
          @click="selectNoteLane(laneSpec.id)"
        >
          {{ laneSpec.label }}
        </button>
        <span class="lane-divider" aria-hidden="true" />
        <button
          v-for="cc in PIANO_ROLL_CC_LANES"
          :key="`cc-${cc.controller}`"
          type="button"
          class="lane-tab"
          :class="{ 'lane-tab-active': laneCc === cc.controller }"
          :title="cc.title"
          role="tab"
          :aria-selected="laneCc === cc.controller"
          @click="selectCcLane(cc.controller)"
        >
          {{ cc.label }}
        </button>
        <button
          type="button"
          class="lane-tab"
          :class="{ 'lane-tab-active': lanePitchBend }"
          :title="t.shell.pianoRoll.bendLaneTitle"
          role="tab"
          :aria-selected="lanePitchBend"
          @click="selectPitchBendLane()"
        >
          {{ t.shell.pianoRoll.bendLaneTab }}
        </button>
        <button
          type="button"
          class="lane-tab"
          :class="{ 'lane-tab-active': laneChannelPressure }"
          :title="t.shell.pianoRoll.pressureLaneTitle"
          role="tab"
          :aria-selected="laneChannelPressure"
          @click="selectChannelPressureLane()"
        >
          {{ t.shell.pianoRoll.pressureLaneTab }}
        </button>
      </div>
      <VelocityLane
        v-if="noteLaneActive"
        class="cell-velocity"
        :range="range"
        :revision="revision"
        :painter="painter"
        :notes="store.notes"
        :selection="store.selection"
        :param="laneParam"
      />
      <BreakpointLane
        v-else-if="laneCc !== null"
        class="cell-velocity"
        :range="range"
        :revision="revision"
        :painter="painter"
        :clip-id="store.clipId"
        :clip-length-ppq="store.clipLengthPpq"
        :points="activeCcPoints"
        :commit="commitCcPoints"
        :readout-label="`CC${laneCc}`"
        :color="trackColor"
        :snap-ppq="ccSnap"
      />
      <BreakpointLane
        v-else-if="lanePitchBend"
        class="cell-velocity"
        :range="range"
        :revision="revision"
        :painter="painter"
        :clip-id="store.clipId"
        :clip-length-ppq="store.clipLengthPpq"
        :points="activePitchBendPoints"
        :commit="commitPitchBendPoints"
        :value-max="MIDI_PITCH_BEND_MAX"
        :center-value="MIDI_PITCH_BEND_CENTER"
        :readout-label="t.shell.pianoRoll.bendLaneTab"
        :aria-label="t.shell.pianoRoll.bendLaneTitle"
        :color="trackColor"
        :snap-ppq="ccSnap"
      />
      <BreakpointLane
        v-else
        class="cell-velocity"
        :range="range"
        :revision="revision"
        :painter="painter"
        :clip-id="store.clipId"
        :clip-length-ppq="store.clipLengthPpq"
        :points="activeChannelPressurePoints"
        :commit="commitChannelPressurePoints"
        :readout-label="t.shell.pianoRoll.pressureLaneTab"
        :aria-label="t.shell.pianoRoll.pressureLaneTitle"
        :color="trackColor"
        :snap-ppq="ccSnap"
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
  background: var(--surface-1);
  color: var(--text-2);
  outline: none;
}

/* The editor auto-focuses on click, so a full accent frame would show on every
 * interaction and read as a heavy border. Keep only a faint hint. */
.piano-roll-editor:focus-visible {
  box-shadow: inset 0 0 0 1px var(--accent-muted);
}

.piano-roll-error {
  margin: 0;
  padding: 0.5rem 0.75rem;
  background: var(--danger-surface);
  color: var(--danger-text);
  font: var(--fs-sm)/1.4 var(--font-sans);
}

.roll-toolbar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.25rem 0.5rem;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border-strong);
  box-shadow: var(--raise-hi);
  font: var(--fs-sm)/1.4 var(--font-sans);
}

.zoom-cluster {
  margin-left: auto;
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.zoom-pair {
  display: flex;
  align-items: center;
  gap: 2px;
}

.zoom-btn {
  flex: none;
  min-width: 1.6rem;
  padding: 0.1rem 0.3rem;
  font: var(--fw-semibold) 11px var(--font-sans);
  color: var(--text-2);
  background: var(--surface-3);
  border-radius: var(--radius-sm);
  box-shadow: var(--control-lift);
  cursor: pointer;
}

.zoom-btn:hover {
  box-shadow: var(--control-lift-hover);
  color: var(--text-1);
}

.zoom-btn:active {
  box-shadow: var(--control-edge), var(--inset-well);
}

.fx-toggle {
  flex: 0 0 auto;
  padding: 0.15rem 0.6rem;
  font: var(--fs-xs)/1.4 var(--font-sans);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.02em;
  color: var(--text-2);
  background: var(--surface-3);
  border-radius: var(--radius-sm);
  box-shadow: var(--control-lift);
  cursor: pointer;
}

.fx-toggle:hover:not(:disabled) {
  box-shadow: var(--control-lift-hover);
  color: var(--text-1);
}

.fx-toggle-active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
}

.fx-toggle:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.overlay-toggle {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  white-space: nowrap;
  cursor: pointer;
  color: var(--text-3);
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
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--dur-1) var(--ease-out);
}

.legend-chip:hover {
  background: var(--surface-3);
}

.legend-chip-active {
  background: var(--accent-soft);
  color: var(--text-1);
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
  flex-direction: column;
  align-items: stretch;
  gap: 1px;
  padding: 2px;
  background: var(--surface-2);
  border-top: 1px solid var(--border-strong);
  overflow: hidden;
}

.lane-tab {
  flex: 1;
  min-height: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  box-shadow: none;
  color: var(--text-4);
  font: var(--fw-semibold) 9px var(--font-sans);
  letter-spacing: 0.06em;
  cursor: pointer;
  transition: background var(--dur-1) var(--ease-out);
}

.lane-tab:hover {
  background: var(--surface-3);
  color: var(--text-3);
}

.lane-tab-active {
  background: var(--surface-3);
  color: var(--text-1);
}

.lane-divider {
  flex: none;
  height: 1px;
  margin: 1px 4px;
  background: var(--border);
}

.cell-velocity {
  grid-area: 2 / 2;
  border-top: 1px solid var(--border-strong);
}

.cell-corner {
  grid-area: 2 / 3;
  background: var(--surface-2);
}

.cell-hscroll-spacer {
  grid-area: 3 / 1;
  background: var(--surface-2);
}

.cell-hscroll {
  grid-area: 3 / 2;
}

.cell-corner-br {
  grid-area: 3 / 3;
  background: var(--surface-2);
}

.scroll-track {
  position: relative;
  background: var(--surface-2);
  box-shadow: var(--inset-well);
  touch-action: none;
}

.scroll-thumb {
  position: absolute;
  background: var(--surface-4);
  border-radius: var(--radius-sm);
  transition: background var(--dur-1) var(--ease-out);
}

.scroll-thumb:hover {
  background: var(--text-4);
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
