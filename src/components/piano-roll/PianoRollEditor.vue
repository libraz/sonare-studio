<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ChordLane from '@/components/arrangement/ChordLane.vue';
import { keyFifthsForScaleHighlight } from '@/components/lists/key-modes';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { useCompositionGuidance } from '@/composables/useCompositionGuidance';
import { useEditorTool } from '@/composables/useEditorTool';
import { useNoteNames } from '@/composables/useNoteNames';
import { usePlacementGuidance } from '@/composables/usePlacementGuidance';
import { useReactiveReharmonization } from '@/composables/useReactiveReharmonization';
import { buildKeyMap } from '@/compose/key-map';
import { isDrumTrack, preferredNoteChannel } from '@/compose/tracks';
import {
  addNote,
  addNotes,
  addNotesInNewClip,
  deleteNotes,
  noteEndLimitPpq,
  redo,
  setActiveClip,
  setSelection,
  splitNote,
  undo,
  updateNotes,
} from '@/project/commands';
import { unfreezeTrack } from '@/project/freeze';
import {
  CLIP_EXPRESSION_CURVES,
  MIDI_PITCH_BEND_CENTER,
  MIDI_PITCH_BEND_MAX,
  PIANO_ROLL_CC_LANES,
} from '@/project/midi-cc';
import { audibleMidiSourceNotes, audibleMidiSourceWindow } from '@/project/midi-projection';
import { useProjectStore } from '@/project/store';
import type { MeasureRange } from '@/project/time-signature';
import type { NewEditorNote } from '@/project/types';
import type { AccessibleObjectAdjustment } from '@/ui/accessibility/object-navigation';
import { usePlayheadFollow } from '@/ui/arrangement/use-playhead-follow';
import { formatMessage, useI18n } from '@/ui/i18n';
import BreakpointLane from './BreakpointLane.vue';
import KeyboardColumn from './KeyboardColumn.vue';
import { LANE_PARAMS, type LaneParamId } from './lane-params';
import NoteGridCanvas from './NoteGridCanvas.vue';
import { clampMoveDelta, clampResizedDuration } from './nudge-bounds';
import { buildGhostNotes, type GhostNote } from './overlay';
import PianoRollMinimap from './PianoRollMinimap.vue';
import PianoRollRuler from './PianoRollRuler.vue';
import PianoRollToolbar from './PianoRollToolbar.vue';
import ReharmonizeLockStrip from './ReharmonizeLockStrip.vue';
import ReharmonizeSuggestion from './ReharmonizeSuggestion.vue';
import { pianoRollStatusLocation } from './status-location';
import { DEFAULT_NOTE_COLOR, KEYBOARD_COLUMN_WIDTH_PX, type NoteColorFn } from './theme';
import {
  floorLocalPpqToMeterGrid,
  localMeasureRange,
  snapLocalPpqToMeterGrid,
} from './timeline-meter';
import { useNoteInteractions } from './use-note-interactions';
import { usePianoRollCcLanes } from './use-piano-roll-cc-lanes';
import { usePianoRollLanes } from './use-piano-roll-lanes';
import { usePianoRollNoteMenu } from './use-piano-roll-note-menu';
import { usePianoRollScrollbar } from './use-piano-roll-scrollbar';
import { usePianoRollViewport } from './use-piano-roll-viewport';
import { usePianoRollZoom } from './use-piano-roll-zoom';
import { describePlacementVerdict, usePlacementCell } from './use-placement-cell';
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
  /** Skip harmonic analysis while the editor is hidden in another dock tab. */
  guidanceEnabled?: boolean;
  /**
   * Audible-feedback hook: plays a short preview of a note's pitch/velocity
   * when one is clicked or created. Omit to edit silently.
   */
  audition?: (pitch: number, velocity: number) => void;
}>();

const emit = defineEmits<{
  /** Request to move the transport playhead to an absolute PPQ position. */
  seek: [ppq: number];
  /** Request to reveal the chord list editor (chord-lane double-click). */
  openChords: [];
}>();

const store = useProjectStore();
const { t } = useI18n();
const { formatPitch } = useNoteNames();
const appSettings = useAppSettings();
const chordKeyFifths = computed(() => keyFifthsForScaleHighlight(store.scaleHighlight));
/** Project key map (declared key plus Key: markers) the chord lane reads chords against. */
const keyMap = computed(() => buildKeyMap(store.scaleHighlight, store.markers));

/** Whether the MIDI-FX transform popover is open. */
const fxPanelOpen = ref(false);

const viewport = usePianoRollViewport({
  // A transform targets a specific clip; close the popover on clip change.
  onClipChange: () => {
    fxPanelOpen.value = false;
    playheadFollow.restart();
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

const lanes = usePianoRollLanes();
const {
  laneParam,
  laneChannel,
  laneCurve,
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

/** The 16 MIDI channel options for the CC-lane channel picker (0-based value). */
const laneChannelOptions = computed(() =>
  Array.from({ length: 16 }, (_, i) => ({
    value: i,
    label: `${t.value.shell.pianoRoll.laneChannelPrefix}${i + 1}`,
  })),
);

const laneCurveOptions = computed(() =>
  CLIP_EXPRESSION_CURVES.map((curve) => ({
    value: curve,
    label: t.value.shell.pianoRoll.expressionCurve[curve],
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
const placementGuide = computed({
  get: () => appSettings.settings.pianoRollPlacementGuide,
  set: (value: boolean) => appSettings.set('pianoRollPlacementGuide', value),
});
const guidanceTint = computed({
  get: () => appSettings.settings.pianoRollGuidanceTint,
  set: (value: boolean) => appSettings.set('pianoRollGuidanceTint', value),
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

const ccLanes = usePianoRollCcLanes({ lanes, gridPpq, snapPpq: (ppq) => snapPianoRollPpq(ppq) });
const {
  polyPressurePitch,
  polyPressurePitches,
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

const polyPressureReadoutLabel = computed(() => {
  if (polyPressurePitches.value.length === 0) return t.value.shell.pianoRoll.polyPressureLaneTab;
  if (polyPressurePitches.value.length === 1 && polyPressurePitch.value !== null) {
    return formatPitch(polyPressurePitch.value);
  }
  return formatMessage(t.value.shell.pianoRoll.polyPressureSelectedKeys, {
    count: polyPressurePitches.value.length,
  });
});

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
const contentReadOnly = computed(() => store.activeTrack?.frozen !== undefined);
/** Notes across every clip on the active track, including clips not open in the roll. */
const activeTrackNotes = computed(() => {
  const track = store.activeTrack;
  return track
    ? (store.clipsByTrack.get(track.id) ?? []).flatMap((clip) => clip.notes)
    : store.notes;
});
/** Percussion tracks keep their GM channel and bypass melodic guidance rules. */
const activeTrackIsDrum = computed(() => isDrumTrack(store.activeTrack, activeTrackNotes.value));

/** Composition-guidance tint segments and hover theory-card resolver. */
const { guidanceSegments, noteCard, noteSafety, resolutionArrows, unresolvedNoteIds } =
  useCompositionGuidance({ enabled: () => props.guidanceEnabled !== false });

/**
 * Reactive melody-first reharmonization: an opt-in auto-suggest that proposes
 * chord changes following the edited melody, plus session-only chord locks.
 */
const {
  autoReharmonize,
  reharmonizeActive,
  pendingProposal,
  pendingChanges,
  applyPendingProposal,
  dismissPendingProposal,
  lockedRegions,
  toggleLock,
} = useReactiveReharmonization();

/** True when a MIDI clip is active and can receive a transform. */
const canTransform = computed(
  () =>
    !contentReadOnly.value && store.clipId >= 0 && (store.activeClip?.kind ?? 'midi') === 'midi',
);

watch(contentReadOnly, (readOnly) => {
  if (readOnly) fxPanelOpen.value = false;
});

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
 * Editable source notes inside the active clip's audible first window. Loop
 * repeats are rendered as playback/score occurrences, while the piano roll
 * edits their shared source note exactly once.
 */
const audibleSourceNotes = computed(() => {
  const clip = store.activeClip;
  if (!clip) return [];
  return audibleMidiSourceNotes(clip);
});

/** Right edge in source coordinates; commits remain the only inverse mapping. */
const sourceWindowEndPpq = computed(() => {
  const clip = store.activeClip;
  return clip ? audibleMidiSourceWindow(clip).endPpq : store.clipLengthPpq;
});
// Edits may run past the clip end: the commit grows the clip. Without a clip, a draw creates one.
const noteEndLimit = computed(() =>
  store.activeClip ? noteEndLimitPpq(store.activeClip) : Number.POSITIVE_INFINITY,
);

/** Left edge in the same source-coordinate frame as editable notes/curves. */
const sourceWindowStartPpq = computed(() => {
  const clip = store.activeClip;
  return clip ? audibleMidiSourceWindow(clip).startPpq : 0;
});

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
  const clip = store.activeClip;
  const window = clip ? audibleMidiSourceWindow(clip) : null;
  fitTimeToSpan(window?.startPpq ?? 0, window?.endPpq ?? store.clipLengthPpq);
}

function fitNotes(): void {
  if (audibleSourceNotes.value.length === 0) {
    fitClip();
    return;
  }
  const endPpq = Math.max(
    ...audibleSourceNotes.value.map((note) => note.startPpq + note.durationPpq),
  );
  const startPpq = Math.min(...audibleSourceNotes.value.map((note) => note.startPpq));
  fitTimeToSpan(startPpq, endPpq);
  fitPitchToNotes(audibleSourceNotes.value);
  bump();
}

function fitSelection(): void {
  const selected = audibleSourceNotes.value.filter((note) => store.selection.has(note.id));
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

defineExpose({ fitSelection, zoomHorizontal });

const { onNoteContext } = usePianoRollNoteMenu({
  contentReadOnly,
  gridPpq,
  snapPpq: (ppq) => snapPianoRollPpq(ppq),
  barLengthPpq: (ppq) => pianoRollMeasureAt(ppq).lengthPpq,
});

type NoteKeyboardAction =
  | { noteId: number; kind: 'select' }
  | { noteId: number; kind: 'adjust'; adjustment: AccessibleObjectAdjustment }
  | { noteId: number; kind: 'set'; controlId: string; value: number };

/** Applies virtual-list note actions through the same selection and undo commands as pointer edits. */
function onNoteKeyboardAction(payload: NoteKeyboardAction): void {
  const note = audibleSourceNotes.value.find((item) => item.id === payload.noteId);
  if (!note) return;
  setSelection([note.id]);
  if (payload.kind === 'select' || contentReadOnly.value) return;
  const minimum = sourceWindowStartPpq.value;
  const maximum = sourceWindowEndPpq.value;
  if (payload.kind === 'set') {
    if (payload.controlId === 'pitch') {
      updateNotes([{ id: note.id, pitch: Math.min(127, Math.max(0, Math.round(payload.value))) }]);
    } else if (payload.controlId === 'start') {
      updateNotes([
        {
          id: note.id,
          startPpq: Math.min(maximum - note.durationPpq, Math.max(minimum, payload.value)),
        },
      ]);
    } else if (payload.controlId === 'duration') {
      updateNotes([
        {
          id: note.id,
          durationPpq: Math.min(maximum - note.startPpq, Math.max(0.0625, payload.value)),
        },
      ]);
    } else if (payload.controlId === 'velocity') {
      updateNotes([
        { id: note.id, velocity: Math.min(127, Math.max(1, Math.round(payload.value))) },
      ]);
    }
    return;
  }
  const { direction, resize, coarse } = payload.adjustment;
  const step = Math.max(0.0625, store.snapEnabled ? gridPpq.value : 0.0625) * (coarse ? 4 : 1);
  if (direction === 'up' || direction === 'down') {
    const delta = direction === 'up' ? (coarse ? 12 : 1) : coarse ? -12 : -1;
    updateNotes([{ id: note.id, pitch: Math.min(127, Math.max(0, note.pitch + delta)) }]);
    return;
  }
  const delta =
    store.snapEnabled && store.snapBar
      ? barKeyboardDelta(note.startPpq, direction, coarse)
      : direction === 'left'
        ? -step
        : step;
  if (resize) {
    updateNotes([{ id: note.id, durationPpq: clampResizedDuration(note, delta, maximum) }]);
  } else {
    updateNotes([
      { id: note.id, startPpq: note.startPpq + clampMoveDelta(delta, [note], minimum, maximum) },
    ]);
  }
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

const timeSignatureOriginPpq = computed(() => {
  const clip = store.activeClip;
  return clip ? clip.startPpq - clip.sourceOffsetPpq : 0;
});

// Leaving the clip-less timeline frame for a clip's source frame keeps the same
// timeline region in view, so a note drawn into a fresh clip stays put.
watch(
  () => (store.activeClip ? timeSignatureOriginPpq.value : null),
  (origin, previous) => {
    if (previous !== null || !origin) return;
    range.setStartPpq(range.startPpq - origin);
    bump();
  },
);

/** Maps a clip-source ruler seek back to an absolute transport PPQ. */
function onRulerSeek(localPpq: number): void {
  emit('seek', Math.max(0, localPpq + timeSignatureOriginPpq.value));
}

const snapPianoRollPpq = (ppq: number): number =>
  snapLocalPpqToMeterGrid(
    store.timeSignatures,
    timeSignatureOriginPpq.value,
    ppq,
    store.snapBar ? 'bar' : gridPpq.value,
  );

const floorPianoRollPpq = (ppq: number): number =>
  floorLocalPpqToMeterGrid(
    store.timeSignatures,
    timeSignatureOriginPpq.value,
    ppq,
    store.snapBar ? 'bar' : gridPpq.value,
  );

/** Bar containing a piano-roll position, resolved on the timeline meter. */
function pianoRollMeasureAt(ppq: number): MeasureRange {
  return localMeasureRange(store.timeSignatures, timeSignatureOriginPpq.value, ppq);
}

/** Moves a piano-roll position to the adjacent real bar boundary in Bar mode. */
function barKeyboardDelta(ppq: number, direction: 'left' | 'right', coarse: boolean): number {
  let cursor = Math.max(0, ppq);
  const steps = coarse ? 4 : 1;
  for (let index = 0; index < steps; index += 1) {
    const current = pianoRollMeasureAt(cursor);
    if (direction === 'right') {
      cursor = current.startPpq + current.lengthPpq;
      continue;
    }
    cursor =
      cursor > current.startPpq + 1e-9
        ? current.startPpq
        : pianoRollMeasureAt(Math.max(0, cursor - 1e-6)).startPpq;
  }
  return cursor - ppq;
}

function resolveScalePitch(pitch: number): number {
  if (activeTrackIsDrum.value || !snapToScaleEnabled.value) return pitch;
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

/** Without an open clip, drawn notes land in a new clip spanning the visible bars. */
function addDrawnNotes(inputs: ReadonlyArray<NewEditorNote>): number[] {
  return store.activeClip ? addNotes(inputs) : addNotesInNewClip(inputs, range.startPpq);
}

const interactions = useNoteInteractions({
  view: range,
  getNotes: () => audibleSourceNotes.value,
  getSelection: () => store.selection,
  // A non-positive step disables snapping in the gesture state machine while
  // the drawn gridlines keep following the configured division.
  getGridPpq: () => (store.snapEnabled ? gridPpq.value : 0),
  snapPpq: snapPianoRollPpq,
  floorPpq: floorPianoRollPpq,
  getTool: () => tool.value,
  isReadOnly: () => contentReadOnly.value,
  getMinPpq: () => sourceWindowStartPpq.value,
  getMaxPpq: () => noteEndLimit.value,
  resolveCreatedPitch: resolveScalePitch,
  resolveEditedPitch: resolveScalePitch,
  getCreatedChannel: () => preferredNoteChannel(store.activeTrack, activeTrackNotes.value),
  commands: {
    addNote: (input) => addDrawnNotes([input])[0],
    addNotes: addDrawnNotes,
    updateNotes,
    deleteNotes,
    setSelection,
    splitNote,
  },
  auditionDuringDrag: () => auditionDrag.value,
  ...(props.audition ? { onAudition: props.audition } : {}),
});

/** The cell the pencil would write and its per-pitch placement verdicts. */
const placementCell = usePlacementCell({
  hoverPpq: computed(() => hoverStatus.value?.ppq ?? null),
  tool,
  previewNotes: interactions.previewNotes,
  drawCellAt: interactions.drawCellAt,
});
const placementColumn = usePlacementGuidance(placementCell);

/** Verdict of the hovered row of the placement column, as status text. */
const placementStatus = computed(() => {
  const hover = hoverStatus.value;
  const verdict = hover ? placementColumn.value?.verdicts[hover.pitch] : undefined;
  if (verdict === undefined) return null;
  const strings = t.value.shell.pianoRoll.placement;
  return describePlacementVerdict(verdict, strings, formatPitch, (trackId) =>
    trackId === null
      ? strings.thisClip
      : (store.tracks.find((track) => track.id === trackId)?.name ?? strings.thisClip),
  );
});

function onKeyDown(event: KeyboardEvent): void {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    target !== event.currentTarget &&
    target.closest(
      'input, textarea, select, button, [contenteditable="true"], [contenteditable=""]',
    )
  ) {
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (contentReadOnly.value) return;
  if (handleKeyboardEdit(event)) return;
  if (interactions.onKeyDown(event.key)) event.preventDefault();
}

function handleKeyboardEdit(event: KeyboardEvent): boolean {
  const selected = audibleSourceNotes.value.filter((note) => store.selection.has(note.id));
  if (selected.length === 0) return false;
  const step = store.snapEnabled ? gridPpq.value : 0.0625;
  let updates: Parameters<typeof updateNotes>[0] = [];
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const direction = event.key === 'ArrowLeft' ? 'left' : 'right';
    const minStart = Math.min(...selected.map((note) => note.startPpq));
    const requestedDelta =
      store.snapEnabled && store.snapBar
        ? barKeyboardDelta(minStart, direction, event.shiftKey)
        : direction === 'left'
          ? -step
          : step;
    const delta = clampMoveDelta(
      requestedDelta,
      selected,
      sourceWindowStartPpq.value,
      noteEndLimit.value,
    );
    if (event.altKey) {
      const ids = addNotes(
        selected.map((note) => ({
          pitch: note.pitch,
          startPpq: note.startPpq + delta,
          durationPpq: note.durationPpq,
          velocity: note.velocity,
          channel: note.channel,
          ...(note.offVelocity !== undefined ? { offVelocity: note.offVelocity } : {}),
        })),
      );
      setSelection(ids);
    } else {
      updates = selected.map((note) => ({
        id: note.id,
        startPpq: note.startPpq + delta,
      }));
    }
  } else if (event.key === '[' || event.key === ']') {
    const delta = event.key === '[' ? -step : step;
    updates = selected.map((note) => ({
      id: note.id,
      durationPpq: clampResizedDuration(note, delta, noteEndLimit.value),
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
  const snap = store.snapEnabled
    ? store.snapBar
      ? 'Bar'
      : `${Math.round(4 / gridPpq.value)}`
    : 'off';
  const lead = [
    store.leadFollowDeferred ? t.value.shell.pianoRoll.placement.leadFollowDeferred : null,
    placementStatus.value,
  ].filter((part): part is string => part !== null);
  const prefix = lead.length > 0 ? `${lead.join(' · ')} · ` : '';
  if (!hover) {
    return `${prefix}${selection} selected · Snap ${snap}`;
  }
  const location = pianoRollStatusLocation(
    store.timeSignatures,
    hover.ppq + timeSignatureOriginPpq.value,
  );
  return `${prefix}${formatPitch(hover.pitch)} · ${location.bar}.${location.beat} · ${hover.ppq.toFixed(3)} ppq · ${selection} selected · Snap ${snap}`;
});

/** Focuses the editor so keyboard shortcuts work after any click inside it. */
function onRootPointerDown(): void {
  root.value?.focus();
}

const playheadFollow = usePlayheadFollow({
  range,
  bump,
  isPlaying: () => props.isPlaying === true,
  followEnabled: () => appSettings.settings.scrollFollowPlayhead,
  positionPpq: () => (props.positionPpq ? localPositionPpq() : undefined),
  leadingColumnWidthPx: KEYBOARD_COLUMN_WIDTH_PX,
});
const { followAnchorLocalX } = playheadFollow;
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
    <div v-if="contentReadOnly" class="piano-roll-readonly" role="status">
      <span>{{ t.shell.arrangement.trackHeader.unfreezeTitle }}</span>
      <button type="button" @click="unfreezeTrack(store.activeTrackId)">
        {{ t.shell.arrangement.trackHeader.unfreeze }}
      </button>
    </div>
    <PianoRollToolbar
      v-model:overlay-enabled="overlayEnabled"
      v-model:fx-panel-open="fxPanelOpen"
      v-model:lane-visible="laneVisible"
      v-model:snap-to-scale="snapToScaleEnabled"
      v-model:ghost-mode="ghostMode"
      v-model:ghost-hide-muted="ghostHideMuted"
      v-model:note-color-mode="noteColorMode"
      v-model:audition-drag="auditionDrag"
      v-model:auto-reharmonize="autoReharmonize"
      v-model:placement-guide="placementGuide"
      v-model:guidance-tint="guidanceTint"
      :read-only="contentReadOnly"
      :drum-track="activeTrackIsDrum"
      :can-transform="canTransform"
      :clip-id="store.clipId"
      :note-count="audibleSourceNotes.length"
      :lane-toggle-disabled="props.forceLaneHidden === true"
      @zoom-horizontal="zoomHorizontal"
      @zoom-vertical="zoomVertical"
      @fit-clip="fitClip"
      @fit-notes="fitNotes"
      @fit-selection="fitSelection"
    />
    <div
      class="piano-roll-layout"
      :class="{ 'lane-hidden': !laneVisible }"
      :style="{ gridTemplateColumns: `${KEYBOARD_COLUMN_WIDTH_PX}px 1fr 12px` }"
    >
      <PianoRollMinimap
        class="cell-minimap"
        :range="range"
        :revision="revision"
        :painter="painter"
        :notes="audibleSourceNotes"
        :clip-length-ppq="sourceWindowEndPpq"
        @scroll-to="scrollMinimapTo"
      />
      <div class="cell-ruler-corner" />
      <PianoRollRuler
        class="cell-ruler"
        :range="range"
        :revision="revision"
        :painter="painter"
        :clip-length-ppq="sourceWindowEndPpq"
        :time-signatures="store.timeSignatures"
        :time-signature-origin-ppq="timeSignatureOriginPpq"
        @seek="onRulerSeek"
      />
      <div class="cell-chord-corner">
        <span>{{ t.shell.pianoRoll.chordLane }}</span>
      </div>
      <ChordLane
        class="cell-chords"
        :range="range"
        :revision="revision"
        :chords="store.chords"
        :time-signatures="store.timeSignatures"
        :origin-ppq="timeSignatureOriginPpq"
        :key-map="keyMap"
        @seek="(ppq) => emit('seek', Math.max(0, ppq))"
        @open-chords="emit('openChords')"
      />
      <div class="cell-chord-spacer" />
      <KeyboardColumn
        class="cell-keyboard"
        :range="range"
        :revision="revision"
        :painter="painter"
        :audition="audition"
      />
      <div ref="gridCell" class="cell-grid">
        <NoteGridCanvas
          :range="range"
          :revision="revision"
          :painter="painter"
          :notes="audibleSourceNotes"
          :selection="store.selection"
          :highlighted-pitch-classes="store.highlightedPitchClasses"
          :grid-ppq="gridPpq"
          :clip-length-ppq="sourceWindowEndPpq"
          :min-ppq="sourceWindowStartPpq"
          :time-signatures="store.timeSignatures"
          :time-signature-origin-ppq="timeSignatureOriginPpq"
          :interactions="interactions"
          :active-tool="tool"
          :position-ppq="props.positionPpq ? localPositionPpq : undefined"
          :anchored-local-x="followAnchorLocalX"
          :note-color="noteColor"
          :ghost-notes="ghostNotes"
          :guidance-segments="guidanceSegments"
          :note-card="noteCard"
          :note-safety="noteSafety"
          :resolution-arrows="resolutionArrows"
          :placement-column="placementColumn"
          :unresolved-note-ids="unresolvedNoteIds"
          @view-resize="viewport.onGridResize"
          @ghost-activate="onGhostActivate"
          @note-context="onNoteContext"
          @note-keyboard-action="onNoteKeyboardAction"
          @hover-status="hoverStatus = $event"
        />
        <ReharmonizeLockStrip
          v-if="reharmonizeActive"
          :range="range"
          :revision="revision"
          :chords="store.chords"
          :origin-ppq="timeSignatureOriginPpq"
          :key-fifths="chordKeyFifths"
          :locks="lockedRegions"
          @toggle="toggleLock"
        />
        <ReharmonizeSuggestion
          v-if="pendingProposal && !contentReadOnly"
          :changes="pendingChanges"
          @apply="applyPendingProposal"
          @dismiss="dismissPendingProposal"
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
        role="group"
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
        <SelectMenu
          v-if="!noteLaneActive"
          v-model="laneCurve"
          class="lane-curve"
          size="sm"
          :options="laneCurveOptions"
          :aria-label="t.shell.pianoRoll.expressionCurveTitle"
          :title="t.shell.pianoRoll.expressionCurveTitle"
        />
        <p v-if="!noteLaneActive" class="mpe-unsupported-note" role="note">
          {{ t.shell.pianoRoll.mpeUnsupported }}
        </p>
      </div>
      <VelocityLane
        v-if="noteLaneActive"
        class="cell-velocity"
        :range="range"
        :revision="revision"
        :painter="painter"
        :notes="audibleSourceNotes"
        :selection="store.selection"
        :param="laneParam"
        :min-ppq="sourceWindowStartPpq"
        :max-ppq="sourceWindowEndPpq"
        :note-color="noteColor"
        :read-only="contentReadOnly"
      />
      <BreakpointLane
        v-else-if="laneCc !== null"
        class="cell-velocity"
        :range="range"
        :revision="revision"
        :painter="painter"
        :clip-id="store.clipId"
        :clip-start-ppq="sourceWindowStartPpq"
        :clip-length-ppq="sourceWindowEndPpq"
        :points="activeCcPoints"
        :commit="commitCcPoints"
        :readout-label="`CC${laneCc}`"
        :color="trackColor"
        :snap-ppq="ccSnap"
        :curve-mode="laneCurve"
        :read-only="contentReadOnly"
      />
      <BreakpointLane
        v-else-if="lanePitchBend"
        class="cell-velocity"
        :range="range"
        :revision="revision"
        :painter="painter"
        :clip-id="store.clipId"
        :clip-start-ppq="sourceWindowStartPpq"
        :clip-length-ppq="sourceWindowEndPpq"
        :points="activePitchBendPoints"
        :commit="commitPitchBendPoints"
        :value-max="MIDI_PITCH_BEND_MAX"
        :center-value="MIDI_PITCH_BEND_CENTER"
        :readout-label="t.shell.pianoRoll.bendLaneTab"
        :aria-label="t.shell.pianoRoll.bendLaneTitle"
        :color="trackColor"
        :snap-ppq="ccSnap"
        :curve-mode="laneCurve"
        :read-only="contentReadOnly"
      />
      <BreakpointLane
        v-else-if="laneChannelPressure"
        class="cell-velocity"
        :range="range"
        :revision="revision"
        :painter="painter"
        :clip-id="store.clipId"
        :clip-start-ppq="sourceWindowStartPpq"
        :clip-length-ppq="sourceWindowEndPpq"
        :points="activeChannelPressurePoints"
        :commit="commitChannelPressurePoints"
        :readout-label="t.shell.pianoRoll.pressureLaneTab"
        :aria-label="t.shell.pianoRoll.pressureLaneTitle"
        :color="trackColor"
        :snap-ppq="ccSnap"
        :curve-mode="laneCurve"
        :read-only="contentReadOnly"
      />
      <BreakpointLane
        v-else
        class="cell-velocity"
        :range="range"
        :revision="revision"
        :painter="painter"
        :clip-id="polyPressurePitches.length === 0 ? -1 : store.clipId"
        :clip-start-ppq="sourceWindowStartPpq"
        :clip-length-ppq="sourceWindowEndPpq"
        :points="activePolyPressurePoints"
        :commit="commitPolyPressurePoints"
        :readout-label="polyPressureReadoutLabel"
        :aria-label="t.shell.pianoRoll.polyPressureLaneTitle"
        :color="trackColor"
        :snap-ppq="ccSnap"
        :curve-mode="laneCurve"
        :read-only="contentReadOnly"
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

<style scoped src="./piano-roll-editor.css"></style>
