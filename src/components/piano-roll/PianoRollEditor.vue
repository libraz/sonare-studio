<script setup lang="ts">
import { computed, ref } from 'vue';
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
  /**
   * Audible-feedback hook: plays a short preview of a note's pitch/velocity
   * when one is clicked or created. Omit to edit silently.
   */
  audition?: (pitch: number, velocity: number) => void;
}>();

const store = useProjectStore();
const { t } = useI18n();

/** Whether the MIDI-FX transform popover is open. */
const fxPanelOpen = ref(false);

const viewport = usePianoRollViewport({
  // A transform targets a specific clip; close the popover on clip change.
  onClipChange: () => {
    fxPanelOpen.value = false;
  },
});
const { range, painter, revision, error, gridPpq, root, gridCell, hTrack, vTrack, bump } = viewport;

/** Whether the multi-track ghost overlay is drawn. */
const overlayEnabled = ref(true);

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
      :can-transform="canTransform"
      :clip-id="store.clipId"
      @zoom-horizontal="zoomHorizontal"
      @zoom-vertical="zoomVertical"
    />
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
        <button
          type="button"
          class="lane-tab"
          :class="{ 'lane-tab-active': lanePolyPressure }"
          :title="t.shell.pianoRoll.polyPressureLaneTitle"
          role="tab"
          :aria-selected="lanePolyPressure"
          @click="selectPolyPressureLane()"
        >
          {{ t.shell.pianoRoll.polyPressureLaneTab }}
        </button>
        <select
          v-if="!noteLaneActive"
          class="lane-channel"
          :title="t.shell.pianoRoll.laneChannelTitle"
          :aria-label="t.shell.pianoRoll.laneChannelTitle"
          :value="laneChannel"
          @change="laneChannel = Number(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="ch in 16" :key="ch" :value="ch - 1">
            {{ t.shell.pianoRoll.laneChannelPrefix }}{{ ch }}
          </option>
        </select>
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
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
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

.lane-channel {
  flex: none;
  min-height: 0;
  padding: 0 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  color: var(--text-2);
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
  cursor: pointer;
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
