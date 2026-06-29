<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { useEditorTool } from '@/composables/useEditorTool';
import { formatPitch } from '@/lib/pitch';
import {
  addNote,
  deleteNotes,
  humanizeSelectionVelocity,
  quantizeSelection,
  quantizeSelectionLengths,
  redo,
  setActiveClip,
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
import { nextPlayheadFollowStart } from '@/ui/arrangement/playhead-follow';
import { useI18n } from '@/ui/i18n';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';
import BreakpointLane from './BreakpointLane.vue';
import KeyboardColumn from './KeyboardColumn.vue';
import { LANE_PARAMS } from './lane-params';
import NoteGridCanvas from './NoteGridCanvas.vue';
import { buildGhostNotes, type GhostNote } from './overlay';
import PianoRollToolbar from './PianoRollToolbar.vue';
import { DEFAULT_NOTE_COLOR, type NoteColorFn } from './theme';
import { useNoteInteractions } from './use-note-interactions';
import { usePianoRollCcLanes } from './use-piano-roll-cc-lanes';
import { usePianoRollLanes } from './use-piano-roll-lanes';
import { usePianoRollScrollbar } from './use-piano-roll-scrollbar';
import { usePianoRollViewport } from './use-piano-roll-viewport';
import { usePianoRollZoom } from './use-piano-roll-zoom';
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
  /** True while the transport is playing; enables playhead follow scrolling. */
  isPlaying?: boolean;
  /**
   * Audible-feedback hook: plays a short preview of a note's pitch/velocity
   * when one is clicked or created. Omit to edit silently.
   */
  audition?: (pitch: number, velocity: number) => void;
}>();

const store = useProjectStore();
const { t } = useI18n();
const appSettings = useAppSettings();

/** Whether the MIDI-FX transform popover is open. */
const fxPanelOpen = ref(false);

/** Per-frame horizontal follow interpolation for piano-roll playback. */
const PLAYHEAD_FOLLOW_SMOOTHING = 0.42;
/** Small PPQ threshold below which snapping avoids endless tiny repaints. */
const PLAYHEAD_FOLLOW_EPSILON_PPQ = 0.0005;

const viewport = usePianoRollViewport({
  // A transform targets a specific clip; close the popover on clip change.
  onClipChange: () => {
    fxPanelOpen.value = false;
  },
});
const { range, painter, revision, error, gridPpq, root, gridCell, hTrack, vTrack, bump } = viewport;

/** Whether the multi-track ghost overlay is drawn. */
const overlayEnabled = ref(true);

/**
 * Whether the bottom velocity / CC parameter lane block is shown. Backed by the
 * shared user preference so the choice is remembered across editors, clip
 * re-opens and restarts; toggling the lane writes the preference through.
 */
const laneVisible = computed({
  get: () => appSettings.settings.pianoRollLaneVisible,
  set: (value: boolean) => appSettings.set('pianoRollLaneVisible', value),
});

/** The scrollable lane-parameter tab column on the left of the lane. */
const laneLabelColumn = ref<HTMLElement | null>(null);

/**
 * The editor root swallows wheel events for zoom/pan (it preventDefaults them),
 * which also blocks native scrolling of this overflowing tab column. When the
 * column can scroll, stop the event before it reaches the root so the browser
 * scrolls the column normally; otherwise let it bubble up to zoom as usual.
 */
function onLabelWheel(event: WheelEvent): void {
  const column = laneLabelColumn.value;
  if (!column || column.scrollHeight <= column.clientHeight) return;
  event.stopPropagation();
}

/** Scrolls the active tab to the vertical center of the column when it changes. */
function centerActiveLaneTab(): void {
  void nextTick(() => {
    const column = laneLabelColumn.value;
    const active = column?.querySelector<HTMLElement>('.lane-tab-active');
    if (!column || !active) return;
    // Measure relative to the column viewport (offsetTop is unreliable here —
    // it is relative to the offsetParent, not this scroll container).
    const columnRect = column.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const delta = activeRect.top - columnRect.top - (column.clientHeight - activeRect.height) / 2;
    const max = column.scrollHeight - column.clientHeight;
    column.scrollTop = Math.max(0, Math.min(max, column.scrollTop + delta));
  });
}

const lanes = usePianoRollLanes();
const {
  laneParam,
  laneChannel,
  laneCc,
  lanePitchBend,
  laneChannelPressure,
  lanePolyPressure,
  noteLaneActive,
  selectNoteLane,
  selectCcLane,
  selectPitchBendLane,
  selectChannelPressureLane,
  selectPolyPressureLane,
} = lanes;

// Keep the selected parameter tab in view: re-center it whenever the active
// lane changes or the block is revealed, so the choice is never hidden off
// the bottom of the scrollable column.
watch(
  [
    laneParam,
    laneCc,
    lanePitchBend,
    laneChannelPressure,
    lanePolyPressure,
    noteLaneActive,
    laneVisible,
  ],
  () => {
    if (laneVisible.value) centerActiveLaneTab();
  },
);

/** The 16 MIDI channel options for the CC-lane channel picker (0-based value). */
const laneChannelOptions = computed(() =>
  Array.from({ length: 16 }, (_, i) => ({
    value: i,
    label: `${t.value.shell.pianoRoll.laneChannelPrefix}${i + 1}`,
  })),
);

const ccLanes = usePianoRollCcLanes({ lanes, gridPpq });
const {
  polyPressurePitch,
  activeCcPoints,
  activePitchBendPoints,
  activeChannelPressurePoints,
  activePolyPressurePoints,
  commitCcPoints,
  commitPitchBendPoints,
  commitChannelPressurePoints,
  commitPolyPressurePoints,
  ccSnap,
} = ccLanes;

const { onWheel, zoomHorizontal, zoomVertical } = usePianoRollZoom({ range, gridCell, bump });

const { vThumbStyle, hThumbStyle, onVScrollDown, onHScrollDown, onScrollMove, onScrollUp } =
  usePianoRollScrollbar({
    range,
    revision,
    hTrack,
    vTrack,
    contentPpq: viewport.contentPpq,
    bump,
  });

/** Active clip color for the CC curve. */
const trackColor = computed(() => store.activeTrack?.color ?? DEFAULT_NOTE_COLOR);

/** True when a MIDI clip is active and can receive a transform. */
const canTransform = computed(
  () => store.clipId >= 0 && (store.activeClip?.kind ?? 'midi') === 'midi',
);

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

const { tool } = useEditorTool();

/** Playhead in the active clip's source-relative frame, matching note PPQ. */
function localPositionPpq(): number {
  const position = props.positionPpq?.() ?? 0;
  const clip = store.activeClip;
  if (!clip) return position;
  return position - clip.startPpq + clip.sourceOffsetPpq;
}

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

let followRaf: number | null = null;

function stopPlayheadFollow(): void {
  if (followRaf !== null) cancelAnimationFrame(followRaf);
  followRaf = null;
}

function followPlayheadTick(): void {
  followRaf = null;
  if (!props.isPlaying) return;
  if (props.positionPpq) {
    const ppq = localPositionPpq();
    const nextStart = nextPlayheadFollowStart(range, ppq);
    if (nextStart !== null) {
      const delta = nextStart - range.startPpq;
      const smoothed =
        Math.abs(delta) <= PLAYHEAD_FOLLOW_EPSILON_PPQ
          ? nextStart
          : range.startPpq + delta * PLAYHEAD_FOLLOW_SMOOTHING;
      range.setStartPpq(smoothed);
      bump();
    }
  }
  followRaf = requestAnimationFrame(followPlayheadTick);
}

function startPlayheadFollow(): void {
  if (followRaf !== null || typeof requestAnimationFrame !== 'function') return;
  followRaf = requestAnimationFrame(followPlayheadTick);
}

watch(
  () => props.isPlaying,
  (playing) => {
    if (playing) startPlayheadFollow();
    else stopPlayheadFollow();
  },
);

onMounted(() => {
  if (props.isPlaying) startPlayheadFollow();
  centerActiveLaneTab();
});

onBeforeUnmount(() => {
  stopPlayheadFollow();
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
    <PianoRollToolbar
      v-model:overlay-enabled="overlayEnabled"
      v-model:fx-panel-open="fxPanelOpen"
      v-model:lane-visible="laneVisible"
      :can-transform="canTransform"
      :clip-id="store.clipId"
      @zoom-horizontal="zoomHorizontal"
      @zoom-vertical="zoomVertical"
    />
    <div class="piano-roll-layout" :class="{ 'lane-hidden': !laneVisible }">
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
          :position-ppq="props.positionPpq ? localPositionPpq : undefined"
          :note-color="noteColor"
          :ghost-notes="ghostNotes"
          @view-resize="viewport.onGridResize"
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
        ref="laneLabelColumn"
        class="cell-velocity-label"
        role="tablist"
        :aria-label="t.shell.pianoRoll.noteLaneParameter"
        @wheel="onLabelWheel"
      >
        <button
          v-for="laneSpec in LANE_PARAMS"
          :key="laneSpec.id"
          type="button"
          class="lane-tab"
          :class="{ 'lane-tab-active': noteLaneActive && laneParam === laneSpec.id }"
          v-tooltip="laneSpec.title"
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
          v-tooltip="cc.title"
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
          v-tooltip="t.shell.pianoRoll.bendLaneTitle"
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
          v-tooltip="t.shell.pianoRoll.pressureLaneTitle"
          role="tab"
          :aria-selected="laneChannelPressure"
          @click="selectChannelPressureLane()"
        >
          {{ t.shell.pianoRoll.pressureLaneTab }}
        </button>
        <button
          type="button"
          class="lane-tab"
          :class="{ 'lane-tab-active': lanePolyPressure }"
          v-tooltip="t.shell.pianoRoll.polyPressureLaneTitle"
          role="tab"
          :aria-selected="lanePolyPressure"
          @click="selectPolyPressureLane()"
        >
          {{ t.shell.pianoRoll.polyPressureLaneTab }}
        </button>
        <SelectMenu
          v-if="!noteLaneActive"
          v-model="laneChannel"
          class="lane-channel"
          size="sm"
          :options="laneChannelOptions"
          :aria-label="t.shell.pianoRoll.laneChannelTitle"
          :title="t.shell.pianoRoll.laneChannelTitle"
        />
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
        v-else-if="laneChannelPressure"
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
      <BreakpointLane
        v-else
        class="cell-velocity"
        :range="range"
        :revision="revision"
        :painter="painter"
        :clip-id="polyPressurePitch === null ? -1 : store.clipId"
        :clip-length-ppq="store.clipLengthPpq"
        :points="activePolyPressurePoints"
        :commit="commitPolyPressurePoints"
        :readout-label="
          polyPressurePitch === null
            ? t.shell.pianoRoll.polyPressureLaneTab
            : formatPitch(polyPressurePitch)
        "
        :aria-label="t.shell.pianoRoll.polyPressureLaneTitle"
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

.piano-roll-layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 72px 1fr 12px;
  grid-template-rows: 1fr 132px 12px;
}

/* Collapse the parameter-lane row when the user hides the block; the grid and
 * scrollbars keep the full remaining height. The lane cells are removed from
 * layout so their canvases stop sizing/painting while hidden. */
.piano-roll-layout.lane-hidden {
  grid-template-rows: 1fr 0 12px;
}

.piano-roll-layout.lane-hidden .cell-velocity-label,
.piano-roll-layout.lane-hidden .cell-velocity,
.piano-roll-layout.lane-hidden .cell-corner {
  display: none;
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
  /* Each tab keeps a legible fixed height; when the full set of note + CC
   * lanes does not fit the column scrolls rather than crushing the labels. */
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
}

.lane-tab {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 16px;
  padding: 1px 2px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  box-shadow: none;
  color: var(--text-4);
  font: var(--fw-semibold) var(--fs-2xs)/1 var(--font-sans);
  letter-spacing: 0.06em;
  cursor: pointer;
  transition: background var(--dur-1) var(--ease-out), color var(--dur-1) var(--ease-out);
}

.lane-tab:hover {
  background: var(--surface-3);
  color: var(--text-2);
}

/* Accent fill so the selected parameter reads clearly in both themes (the grey
 * surface tint was too faint against the panel, especially in light mode). */
.lane-tab-active,
.lane-tab-active:hover {
  background: var(--accent);
  color: var(--accent-text);
  box-shadow: var(--raise-hi), var(--shadow-1);
}

.lane-divider {
  flex: none;
  height: 1px;
  margin: 1px 4px;
  background: var(--border);
}

/* Keep the channel picker from stretching as a flex item in the lane column;
 * the frosted trigger carries its own surface, padding and typography. */
.lane-channel {
  flex: none;
  min-height: 0;
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
  /* Lift the resting fill toward text-4 so the thumb is legible against the
   * inset track even before hover; brightens on hover, darkens while grabbing. */
  background: color-mix(in srgb, var(--text-4) 55%, var(--surface-4));
  border-radius: var(--radius-sm);
  transition: background var(--dur-1) var(--ease-out);
}

.scroll-thumb:hover {
  background: var(--text-4);
}

.scroll-track:active .scroll-thumb {
  background: var(--text-3);
}

.scroll-thumb-v {
  left: 1px;
  right: 1px;
}

.scroll-thumb-h {
  top: 1px;
  bottom: 1px;
}
</style>
