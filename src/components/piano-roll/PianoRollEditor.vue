<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { useEditorTool } from '@/composables/useEditorTool';
import { formatPitch } from '@/lib/pitch';
import {
  addNote,
  cleanupOverlaps,
  deleteNotes,
  duplicateSelection,
  fadeSelectionVelocity,
  humanizeSelectionVelocity,
  legatoSelection,
  mergeSelection,
  normalizeSelectionVelocity,
  quantizeSelection,
  quantizeSelectionEnds,
  quantizeSelectionLengths,
  redo,
  repeatSelection,
  scaleSelectionVelocityDynamics,
  selectOutOfScale,
  selectOverlaps,
  selectSameChannel,
  selectSamePitch,
  selectVelocityRange,
  setActiveClip,
  setSelection,
  snapSelectionToScale,
  splitNote,
  transposeSelection,
  transposeSelectionDiatonic,
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
import { beatLengthPpq, rulerTicks } from '@/ui/arrangement/ruler';
import { useI18n } from '@/ui/i18n';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';
import BreakpointLane from './BreakpointLane.vue';
import KeyboardColumn from './KeyboardColumn.vue';
import { LANE_PARAMS, type LaneParamId } from './lane-params';
import NoteGridCanvas from './NoteGridCanvas.vue';
import { buildGhostNotes, type GhostNote } from './overlay';
import PianoRollMinimap from './PianoRollMinimap.vue';
import PianoRollRuler from './PianoRollRuler.vue';
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
  /** Hides the bottom velocity / CC lane without changing the saved user preference. */
  forceLaneHidden?: boolean;
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
/** Follow scrolling redraws the full piano-roll base layer, so cap it below display refresh. */
const PLAYHEAD_FOLLOW_INTERVAL_MS = 33;
/** Ignore sub-pixel follow movement; the overlay playhead still updates every frame. */
const PLAYHEAD_FOLLOW_MIN_PX = 1;

const viewport = usePianoRollViewport({
  // A transform targets a specific clip; close the popover on clip change.
  onClipChange: () => {
    fxPanelOpen.value = false;
  },
});
const { range, painter, revision, error, gridPpq, root, gridCell, hTrack, vTrack, bump } = viewport;

/** Whether the multi-track ghost overlay is drawn. */
const overlayEnabled = ref(true);
const hoverStatus = ref<{ ppq: number; pitch: number } | null>(null);

/**
 * Whether the bottom velocity / CC parameter lane block is shown. Backed by the
 * shared user preference so the choice is remembered across editors, clip
 * re-opens and restarts; toggling the lane writes the preference through.
 */
const savedLaneVisible = computed({
  get: () => appSettings.settings.pianoRollLaneVisible,
  set: (value: boolean) => appSettings.set('pianoRollLaneVisible', value),
});
const laneVisible = computed({
  get: () => (props.forceLaneHidden === true ? false : savedLaneVisible.value),
  set: (value: boolean) => {
    savedLaneVisible.value = value;
  },
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

const snapToScaleEnabled = computed({
  get: () => appSettings.settings.pianoRollSnapToScale,
  set: (value: boolean) => appSettings.set('pianoRollSnapToScale', value),
});
const ghostMode = computed({
  get: () => appSettings.settings.pianoRollGhostMode,
  set: (value: 'all' | 'active-track' | 'none') => appSettings.set('pianoRollGhostMode', value),
});
const ghostHideMuted = computed({
  get: () => appSettings.settings.pianoRollGhostHideMuted,
  set: (value: boolean) => appSettings.set('pianoRollGhostHideMuted', value),
});
const noteColorMode = computed({
  get: () => appSettings.settings.pianoRollNoteColorMode,
  set: (value: 'track' | 'velocity' | 'channel') =>
    appSettings.set('pianoRollNoteColorMode', value),
});
const auditionDrag = computed({
  get: () => appSettings.settings.pianoRollAuditionDrag,
  set: (value: boolean) => appSettings.set('pianoRollAuditionDrag', value),
});

const laneModeOptions = computed(() => [
  ...LANE_PARAMS.map((laneSpec) => ({
    value: `note:${laneSpec.id}`,
    label: `${t.value.shell.pianoRoll.laneGroupNote} · ${laneSpec.label}`,
  })),
  ...PIANO_ROLL_CC_LANES.map((cc) => ({
    value: `cc:${cc.controller}`,
    label: `${t.value.shell.pianoRoll.laneGroupCc} · ${cc.label}`,
  })),
  {
    value: 'expr:bend',
    label: `${t.value.shell.pianoRoll.laneGroupExpression} · ${t.value.shell.pianoRoll.bendLaneTab}`,
  },
  {
    value: 'expr:pressure',
    label: `${t.value.shell.pianoRoll.laneGroupExpression} · ${t.value.shell.pianoRoll.pressureLaneTab}`,
  },
  {
    value: 'expr:poly-pressure',
    label: `${t.value.shell.pianoRoll.laneGroupExpression} · ${t.value.shell.pianoRoll.polyPressureLaneTab}`,
  },
]);

const laneMode = computed({
  get: () => {
    if (noteLaneActive.value) return `note:${laneParam.value}`;
    if (laneCc.value !== null) return `cc:${laneCc.value}`;
    if (lanePitchBend.value) return 'expr:bend';
    if (laneChannelPressure.value) return 'expr:pressure';
    return 'expr:poly-pressure';
  },
  set: (value: string) => {
    if (value.startsWith('note:')) {
      selectNoteLane(value.slice(5) as LaneParamId);
      return;
    }
    if (value.startsWith('cc:')) {
      selectCcLane(Number(value.slice(3)));
      return;
    }
    if (value === 'expr:bend') selectPitchBendLane();
    else if (value === 'expr:pressure') selectChannelPressureLane();
    else selectPolyPressureLane();
  },
});

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
  overlayEnabled.value && ghostMode.value !== 'none'
    ? (() => {
        const tracks = store.tracks.filter((track) => {
          if (ghostHideMuted.value && track.mute) return false;
          if (ghostMode.value === 'active-track') return track.id === store.activeTrackId;
          return true;
        });
        const trackIds = new Set(tracks.map((track) => track.id));
        return buildGhostNotes({
          clips: store.clips.filter((clip) => trackIds.has(clip.trackId)),
          tracks,
          activeClipId: store.clipId,
        });
      })()
    : [],
);

/**
 * Color resolver for the editable notes: the active track's color at full
 * saturation. A new function identity per color change keeps the grid's
 * redraw watcher firing.
 */
const noteColor = computed<NoteColorFn>(() => {
  const color = store.activeTrack?.color ?? DEFAULT_NOTE_COLOR;
  if (noteColorMode.value === 'velocity') {
    return (note) => {
      const hue = 210 - Math.round((note.velocity / 127) * 170);
      return `hsl(${hue} 78% 58%)`;
    };
  }
  if (noteColorMode.value === 'channel') {
    return (note) => `hsl(${(note.channel * 37) % 360} 72% 58%)`;
  }
  return () => color;
});

function fitTimeToSpan(startPpq: number, endPpq: number): void {
  const width = Math.max(1, range.widthPx);
  const paddedStart = Math.max(0, startPpq - 0.5);
  const paddedEnd = Math.max(paddedStart + 0.25, endPpq + 0.5);
  const targetPxPerPpq = width / (paddedEnd - paddedStart);
  range.zoomAt(0, targetPxPerPpq / range.pxPerPpq);
  range.setStartPpq(paddedStart);
  bump();
}

function fitPitchToNotes(notes: ReadonlyArray<{ pitch: number }>): void {
  if (notes.length === 0 || range.heightPx <= 0) return;
  let minPitch = 127;
  let maxPitch = 0;
  for (const note of notes) {
    minPitch = Math.min(minPitch, note.pitch);
    maxPitch = Math.max(maxPitch, note.pitch);
  }
  const span = Math.max(1, maxPitch - minPitch + 1);
  const rowHeight = Math.min(40, Math.max(5, (range.heightPx - 16) / (span + 2)));
  range.setRowHeight(rowHeight);
  const centerPitch = (minPitch + maxPitch) / 2;
  const rowTop = (127 - centerPitch) * range.rowHeight;
  range.setScrollY(rowTop + range.rowHeight / 2 - range.heightPx / 2);
}

function fitClip(): void {
  fitTimeToSpan(0, store.clipLengthPpq);
}

function fitNotes(): void {
  if (store.notes.length === 0) {
    fitClip();
    return;
  }
  const endPpq = Math.max(...store.notes.map((note) => note.startPpq + note.durationPpq));
  const startPpq = Math.min(...store.notes.map((note) => note.startPpq));
  fitTimeToSpan(startPpq, endPpq);
  fitPitchToNotes(store.notes);
  bump();
}

function fitSelection(): void {
  const selected = store.selectedNotes;
  if (selected.length === 0) {
    fitNotes();
    return;
  }
  const endPpq = Math.max(...selected.map((note) => note.startPpq + note.durationPpq));
  const startPpq = Math.min(...selected.map((note) => note.startPpq));
  fitTimeToSpan(startPpq, endPpq);
  fitPitchToNotes(selected);
  bump();
}

/** Maximum per-note random velocity jitter applied by the Humanize action. */
const HUMANIZE_VELOCITY_AMOUNT = 12;

/** Selection-wide note operations shared by the note and empty-space menus. */
function selectionOpItems(): ContextMenuItem[] {
  return [
    {
      id: 'edit-submenu',
      label: t.value.shell.pianoRoll.context.edit,
      children: [
        {
          id: 'duplicate-grid',
          label: t.value.shell.pianoRoll.context.duplicateByGrid,
          hint: '⌥→',
          run: () => duplicateSelection(gridPpq.value),
        },
        {
          id: 'repeat-bar',
          label: t.value.shell.pianoRoll.context.repeatBar,
          run: () => repeatSelection(3, 4),
        },
        { id: 'sep-edit-tools', separator: true },
        {
          id: 'legato',
          label: t.value.shell.pianoRoll.context.legato,
          run: () => legatoSelection(),
        },
        {
          id: 'merge',
          label: t.value.shell.pianoRoll.context.merge,
          run: () => mergeSelection(),
        },
        {
          id: 'cleanup-overlaps',
          label: t.value.shell.pianoRoll.context.cleanupOverlaps,
          run: () => cleanupOverlaps(),
        },
      ],
    },
    {
      id: 'quantize-submenu',
      label: t.value.shell.pianoRoll.context.quantize,
      children: [
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
          id: 'quantize-end',
          label: t.value.shell.pianoRoll.context.quantizeEnds,
          run: () => quantizeSelectionEnds(),
        },
      ],
    },
    {
      id: 'transpose-submenu',
      label: t.value.shell.pianoRoll.context.transpose,
      children: [
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
        { id: 'sep-transpose', separator: true },
        {
          id: 'diatonic-up',
          label: t.value.shell.pianoRoll.context.diatonicUp,
          run: () => transposeSelectionDiatonic(1),
        },
        {
          id: 'diatonic-down',
          label: t.value.shell.pianoRoll.context.diatonicDown,
          run: () => transposeSelectionDiatonic(-1),
        },
        {
          id: 'snap-scale',
          label: t.value.shell.pianoRoll.context.snapToScale,
          run: () => snapSelectionToScale(),
        },
      ],
    },
    {
      id: 'velocity-submenu',
      label: t.value.shell.pianoRoll.context.velocity,
      children: [
        {
          id: 'humanize',
          label: t.value.shell.pianoRoll.context.humanizeVelocity,
          run: () => humanizeSelectionVelocity(HUMANIZE_VELOCITY_AMOUNT),
        },
        {
          id: 'vel-fade-in',
          label: t.value.shell.pianoRoll.context.velocityFadeIn,
          run: () => fadeSelectionVelocity(40, 110),
        },
        {
          id: 'vel-fade-out',
          label: t.value.shell.pianoRoll.context.velocityFadeOut,
          run: () => fadeSelectionVelocity(110, 40),
        },
        {
          id: 'vel-normalize',
          label: t.value.shell.pianoRoll.context.velocityNormalize,
          run: () => normalizeSelectionVelocity(110),
        },
        {
          id: 'vel-compress',
          label: t.value.shell.pianoRoll.context.velocityCompress,
          run: () => scaleSelectionVelocityDynamics(0.6),
        },
        {
          id: 'vel-expand',
          label: t.value.shell.pianoRoll.context.velocityExpand,
          run: () => scaleSelectionVelocityDynamics(1.35),
        },
      ],
    },
    {
      id: 'select-submenu',
      label: t.value.shell.pianoRoll.context.select,
      children: [
        {
          id: 'select-same-pitch',
          label: t.value.shell.pianoRoll.context.selectSamePitch,
          run: () => selectSamePitch(),
        },
        {
          id: 'select-same-channel',
          label: t.value.shell.pianoRoll.context.selectSameChannel,
          run: () => selectSameChannel(),
        },
        {
          id: 'select-velocity-range',
          label: t.value.shell.pianoRoll.context.selectVelocityRange,
          run: () => selectVelocityRange(),
        },
        {
          id: 'select-out-scale',
          label: t.value.shell.pianoRoll.context.selectOutOfScale,
          run: () => selectOutOfScale(),
        },
        {
          id: 'select-overlaps',
          label: t.value.shell.pianoRoll.context.selectOverlaps,
          run: () => selectOverlaps(),
        },
      ],
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

function resolveCreatedPitch(pitch: number): number {
  if (!snapToScaleEnabled.value) return pitch;
  const mask = store.highlightedPitchClasses;
  if (!mask.some(Boolean) || mask[((pitch % 12) + 12) % 12]) return pitch;
  for (let distance = 1; distance <= 12; distance++) {
    const up = pitch + distance;
    if (up <= 127 && mask[((up % 12) + 12) % 12]) return up;
    const down = pitch - distance;
    if (down >= 0 && mask[((down % 12) + 12) % 12]) return down;
  }
  return pitch;
}

const interactions = useNoteInteractions({
  view: range,
  getNotes: () => store.notes,
  getSelection: () => store.selection,
  // A non-positive step disables snapping in the gesture state machine while
  // the drawn gridlines keep following the configured division.
  getGridPpq: () => (store.snapEnabled ? gridPpq.value : 0),
  getTool: () => tool.value,
  getMaxPpq: () => store.clipLengthPpq,
  resolveCreatedPitch,
  commands: { addNote, updateNotes, deleteNotes, setSelection, splitNote },
  auditionDuringDrag: () => auditionDrag.value,
  ...(props.audition ? { onAudition: props.audition } : {}),
});

function onKeyDown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (handleKeyboardEdit(event)) return;
  if (interactions.onKeyDown(event.key)) event.preventDefault();
}

function handleKeyboardEdit(event: KeyboardEvent): boolean {
  const selected = store.selectedNotes;
  if (selected.length === 0) return false;
  const step = store.snapEnabled ? gridPpq.value : 0.0625;
  let updates: Parameters<typeof updateNotes>[0] = [];
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const delta = event.key === 'ArrowLeft' ? -step : step;
    if (event.altKey) {
      const ids = selected.map((note) =>
        addNote({
          pitch: note.pitch,
          startPpq: Math.max(0, note.startPpq + delta),
          durationPpq: note.durationPpq,
          velocity: note.velocity,
          channel: note.channel,
          ...(note.offVelocity !== undefined ? { offVelocity: note.offVelocity } : {}),
        }),
      );
      setSelection(ids);
    } else {
      updates = selected.map((note) => ({
        id: note.id,
        startPpq: Math.max(0, note.startPpq + delta),
      }));
    }
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const semitones = event.shiftKey ? 12 : 1;
    const delta = event.key === 'ArrowUp' ? semitones : -semitones;
    if (event.altKey) {
      const ids = selected.map((note) =>
        addNote({
          pitch: Math.min(127, Math.max(0, note.pitch + delta)),
          startPpq: note.startPpq,
          durationPpq: note.durationPpq,
          velocity: note.velocity,
          channel: note.channel,
          ...(note.offVelocity !== undefined ? { offVelocity: note.offVelocity } : {}),
        }),
      );
      setSelection(ids);
    } else {
      updates = selected.map((note) => ({
        id: note.id,
        pitch: Math.min(127, Math.max(0, note.pitch + delta)),
      }));
    }
  } else if (event.key === '[' || event.key === ']') {
    const delta = event.key === '[' ? -step : step;
    updates = selected.map((note) => ({
      id: note.id,
      durationPpq: Math.max(0.0625, note.durationPpq + delta),
    }));
  } else {
    return false;
  }
  event.preventDefault();
  if (updates.length > 0) updateNotes(updates);
  return true;
}

function scrollMinimapTo(centerPpq: number): void {
  range.setStartPpq(centerPpq - (range.endPpq - range.startPpq) / 2);
  bump();
}

const statusText = computed(() => {
  const hover = hoverStatus.value;
  const selection = store.selection.size;
  const snap = store.snapEnabled ? `${Math.round(4 / gridPpq.value)}` : 'off';
  if (!hover) {
    return `${selection} selected · Snap ${snap}`;
  }
  const ticks = rulerTicks(store.timeSignatures, 0, hover.ppq + 0.001, 100);
  const bar = [...ticks].reverse().find((tick) => tick.kind === 'bar');
  const beatLength = beatLengthPpq(
    [...store.timeSignatures].reverse().find((segment) => segment.startPpq <= hover.ppq) ?? {
      startPpq: 0,
      numerator: 4,
      denominator: 4,
    },
  );
  const beat = bar ? Math.floor((hover.ppq - bar.ppq) / beatLength) + 1 : 1;
  const barLabel = bar?.barNumber ?? 1;
  return `${formatPitch(hover.pitch)} · ${barLabel}.${beat} · ${hover.ppq.toFixed(3)} ppq · ${selection} selected · Snap ${snap}`;
});

/** Focuses the editor so keyboard shortcuts work after any click inside it. */
function onRootPointerDown(): void {
  root.value?.focus();
}

let followRaf: number | null = null;
let lastFollowFrameMs = 0;

function stopPlayheadFollow(): void {
  if (followRaf !== null) cancelAnimationFrame(followRaf);
  followRaf = null;
}

function followPlayheadTick(now = performance.now()): void {
  followRaf = null;
  if (!props.isPlaying || !appSettings.settings.scrollFollowPlayhead) return;
  if (now - lastFollowFrameMs < PLAYHEAD_FOLLOW_INTERVAL_MS) {
    followRaf = requestAnimationFrame(followPlayheadTick);
    return;
  }
  lastFollowFrameMs = now;
  if (props.positionPpq) {
    const ppq = localPositionPpq();
    const nextStart = nextPlayheadFollowStart(range, ppq);
    if (nextStart !== null) {
      const delta = nextStart - range.startPpq;
      if (Math.abs(delta * range.pxPerPpq) >= PLAYHEAD_FOLLOW_MIN_PX) {
        const smoothed =
          Math.abs(delta) <= PLAYHEAD_FOLLOW_EPSILON_PPQ
            ? nextStart
            : range.startPpq + delta * PLAYHEAD_FOLLOW_SMOOTHING;
        range.setStartPpq(smoothed);
        bump();
      }
    }
  }
  followRaf = requestAnimationFrame(followPlayheadTick);
}

function startPlayheadFollow(): void {
  if (followRaf !== null || typeof requestAnimationFrame !== 'function') return;
  lastFollowFrameMs = 0;
  followRaf = requestAnimationFrame(followPlayheadTick);
}

watch(
  () => [props.isPlaying, appSettings.settings.scrollFollowPlayhead],
  ([playing, follow]) => {
    if (playing && follow) startPlayheadFollow();
    else stopPlayheadFollow();
  },
);

onMounted(() => {
  if (props.isPlaying && appSettings.settings.scrollFollowPlayhead) startPlayheadFollow();
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
      v-model:snap-to-scale="snapToScaleEnabled"
      v-model:ghost-mode="ghostMode"
      v-model:ghost-hide-muted="ghostHideMuted"
      v-model:note-color-mode="noteColorMode"
      v-model:audition-drag="auditionDrag"
      :can-transform="canTransform"
      :clip-id="store.clipId"
      :note-count="store.notes.length"
      :lane-toggle-disabled="props.forceLaneHidden === true"
      @zoom-horizontal="zoomHorizontal"
      @zoom-vertical="zoomVertical"
      @fit-clip="fitClip"
      @fit-notes="fitNotes"
      @fit-selection="fitSelection"
    />
    <div class="piano-roll-layout" :class="{ 'lane-hidden': !laneVisible }">
      <PianoRollMinimap
        class="cell-minimap"
        :range="range"
        :revision="revision"
        :painter="painter"
        :notes="store.notes"
        :clip-length-ppq="store.clipLengthPpq"
        @scroll-to="scrollMinimapTo"
      />
      <div class="cell-ruler-corner" />
      <PianoRollRuler
        class="cell-ruler"
        :range="range"
        :revision="revision"
        :painter="painter"
        :clip-length-ppq="store.clipLengthPpq"
        :time-signatures="store.timeSignatures"
      />
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
          @hover-status="hoverStatus = $event"
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
        <SelectMenu
          v-model="laneMode"
          class="lane-mode-select"
          size="sm"
          :options="laneModeOptions"
          :aria-label="t.shell.pianoRoll.noteLaneParameter"
        />
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
      <div class="cell-status" aria-live="polite">{{ statusText }}</div>
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
  grid-template-rows: 18px 24px 1fr 132px 12px 22px;
}

/* Collapse the parameter-lane row when the user hides the block; the grid and
 * scrollbars keep the full remaining height. The lane cells are removed from
 * layout so their canvases stop sizing/painting while hidden. */
.piano-roll-layout.lane-hidden {
  grid-template-rows: 18px 24px 1fr 0 12px 22px;
}

.piano-roll-layout.lane-hidden .cell-velocity-label,
.piano-roll-layout.lane-hidden .cell-velocity,
.piano-roll-layout.lane-hidden .cell-corner {
  display: none;
}

.cell-minimap {
  grid-area: 1 / 1 / 2 / 4;
}

.cell-ruler-corner {
  grid-area: 2 / 1;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border-strong);
}

.cell-ruler {
  grid-area: 2 / 2;
}

.cell-keyboard {
  grid-area: 3 / 1;
}

.cell-grid {
  grid-area: 3 / 2;
  position: relative;
  min-width: 0;
  min-height: 0;
}

.cell-vscroll {
  grid-area: 3 / 3;
}

.cell-velocity-label {
  grid-area: 4 / 1;
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

.lane-group-label {
  flex: none;
  padding: 3px 2px 1px;
  color: var(--text-4);
  font: var(--fw-semibold) 8px/1 var(--font-sans);
  letter-spacing: 0.08em;
  text-align: center;
  text-transform: uppercase;
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

.lane-mode-select {
  flex: none;
  min-width: 0;
}

.cell-velocity {
  grid-area: 4 / 2;
  border-top: 1px solid var(--border-strong);
}

.cell-corner {
  grid-area: 4 / 3;
  background: var(--surface-2);
}

.cell-hscroll-spacer {
  grid-area: 5 / 1;
  background: var(--surface-2);
}

.cell-hscroll {
  grid-area: 5 / 2;
}

.cell-corner-br {
  grid-area: 5 / 3;
  background: var(--surface-2);
}

.cell-status {
  grid-area: 6 / 1 / 7 / 4;
  display: flex;
  align-items: center;
  padding: 0 0.5rem;
  border-top: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text-3);
  font: var(--fs-xs) / 1.2 var(--font-sans);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
