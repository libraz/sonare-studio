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
  applyGrooveToSelection,
  captureGrooveFromSelection,
  cleanupOverlaps,
  copySelectedNotes,
  cutSelectedNotes,
  deleteNotes,
  duplicateSelection,
  fadeSelectionVelocity,
  humanizeSelectionVelocity,
  legatoSelection,
  mergeSelection,
  normalizeSelectionVelocity,
  pasteNotesAt,
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
import { unfreezeTrack } from '@/project/freeze';
import { grooveTemplateIsUsable } from '@/project/groove';
import {
  CLIP_EXPRESSION_CURVES,
  MIDI_PITCH_BEND_CENTER,
  MIDI_PITCH_BEND_MAX,
  PIANO_ROLL_CC_LANES,
} from '@/project/midi-cc';
import {
  audibleMidiSourceNotes,
  audibleMidiSourceWindow,
  midiSourcePpqToTimeline,
} from '@/project/midi-projection';
import { useProjectStore } from '@/project/store';
import { measureRangeAt, snapPpqToMeterGrid } from '@/project/time-signature';
import type { AccessibleObjectAdjustment } from '@/ui/accessibility/object-navigation';
import {
  anchoredPlayheadFollowStart,
  PLAYHEAD_FOLLOW_ANCHOR_X,
  revealPlayheadStart,
} from '@/ui/arrangement/playhead-follow';
import { localizeMeter } from '@/ui/arrangement/ruler';
import { formatMessage, useI18n } from '@/ui/i18n';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';
import BreakpointLane from './BreakpointLane.vue';
import KeyboardColumn from './KeyboardColumn.vue';
import { LANE_PARAMS, type LaneParamId } from './lane-params';
import NoteGridCanvas from './NoteGridCanvas.vue';
import { buildGhostNotes, type GhostNote } from './overlay';
import PianoRollMinimap from './PianoRollMinimap.vue';
import PianoRollRuler from './PianoRollRuler.vue';
import PianoRollToolbar from './PianoRollToolbar.vue';
import ReharmonizeLockStrip from './ReharmonizeLockStrip.vue';
import ReharmonizeSuggestion from './ReharmonizeSuggestion.vue';
import { pianoRollStatusLocation } from './status-location';
import { DEFAULT_NOTE_COLOR, KEYBOARD_COLUMN_WIDTH_PX, type NoteColorFn } from './theme';
import { useNoteInteractions } from './use-note-interactions';
import { usePianoRollCcLanes } from './use-piano-roll-cc-lanes';
import { usePianoRollLanes } from './use-piano-roll-lanes';
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

/** Per-frame horizontal follow interpolation for piano-roll playback. */
const PLAYHEAD_FOLLOW_SMOOTHING = 0.42;
/** Small PPQ threshold below which snapping avoids endless tiny repaints. */
const PLAYHEAD_FOLLOW_EPSILON_PPQ = 0.0005;
/** Follow scrolling redraws the full piano-roll base layer, so cap it below display refresh. */
const PLAYHEAD_FOLLOW_INTERVAL_MS = 33;
/** Ignore sub-pixel follow movement; the overlay playhead still updates every frame. */
const PLAYHEAD_FOLLOW_MIN_PX = 1;
/** Local column the playhead is pinned to while following (past the keyboard). */
const PLAYHEAD_ANCHOR_LOCAL_X = Math.max(0, PLAYHEAD_FOLLOW_ANCHOR_X - KEYBOARD_COLUMN_WIDTH_PX);

const viewport = usePianoRollViewport({
  // A transform targets a specific clip; close the popover on clip change.
  onClipChange: () => {
    fxPanelOpen.value = false;
    stopPlayheadFollow();
    if (props.isPlaying && appSettings.settings.scrollFollowPlayhead) startPlayheadFollow();
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

/** Maximum per-note random velocity jitter applied by the Humanize action. */
const HUMANIZE_VELOCITY_AMOUNT = 12;

/** Timeline span occupied by the selected phrase, used as its repeat interval. */
function selectionSpanPpq(): number {
  const selected = store.selectedNotes;
  if (selected.length === 0) return 0;
  const start = Math.min(...selected.map((note) => note.startPpq));
  const end = Math.max(...selected.map((note) => note.startPpq + note.durationPpq));
  return Math.max(0, end - start);
}

/** Selection-wide note operations shared by the note and empty-space menus. */
function selectionOpItems(): ContextMenuItem[] {
  return [
    {
      id: 'edit-submenu',
      label: t.value.shell.pianoRoll.context.edit,
      disabled: contentReadOnly.value,
      children: [
        {
          id: 'duplicate-grid',
          label: t.value.shell.pianoRoll.context.duplicateByGrid,
          hint: '⌥→',
          run: () => duplicateSelection(selectionSpanPpq()),
        },
        {
          id: 'repeat-bar',
          label: t.value.shell.pianoRoll.context.repeatBar,
          run: () => repeatSelection(3, selectionSpanPpq()),
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
      disabled: contentReadOnly.value,
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
        { id: 'sep-quantize-feel', separator: true },
        ...[0.25, 0.5, 0.75, 1].map((strength) => ({
          id: `quantize-strength-${strength}`,
          label: `${t.value.shell.pianoRoll.midiTransform.strength} ${Math.round(strength * 100)}%`,
          checked: Math.abs(store.quantizeStrength - strength) < 1e-9,
          run: () => {
            store.quantizeStrength = strength;
            quantizeSelection();
          },
        })),
        ...[0, 25, 50, 75, 100].map((swing) => ({
          id: `quantize-swing-${swing}`,
          label: `${t.value.shell.editor.swing} ${swing}%`,
          checked: store.quantizeSwing === swing,
          run: () => {
            store.quantizeSwing = swing;
            quantizeSelection();
          },
        })),
        { id: 'sep-groove', separator: true },
        {
          id: 'groove-capture',
          label: t.value.shell.pianoRoll.context.grooveCapture,
          run: () => {
            store.grooveTemplate = captureGrooveFromSelection();
          },
        },
        {
          id: 'groove-apply',
          label: grooveTemplateIsUsable(store.grooveTemplate)
            ? t.value.shell.pianoRoll.context.grooveApply
            : `${t.value.shell.pianoRoll.context.grooveApply} — ${t.value.shell.pianoRoll.context.grooveEmpty}`,
          disabled: !grooveTemplateIsUsable(store.grooveTemplate),
          run: () => {
            const groove = store.grooveTemplate;
            if (groove) applyGrooveToSelection(groove, store.quantizeStrength);
          },
        },
        {
          id: 'groove-clear',
          label: t.value.shell.pianoRoll.context.grooveClear,
          disabled: store.grooveTemplate === null,
          run: () => {
            store.grooveTemplate = null;
          },
        },
      ],
    },
    {
      id: 'transpose-submenu',
      label: t.value.shell.pianoRoll.context.transpose,
      disabled: contentReadOnly.value,
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
      disabled: contentReadOnly.value,
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
  const activeClip = store.activeClip;
  const pasteAtCursor = () => {
    if (activeClip === null) return;
    pasteNotesAt(midiSourcePpqToTimeline(activeClip, payload.ppq));
  };
  if (payload.noteId !== null) {
    const note = store.notes.find((n) => n.id === payload.noteId);
    if (note) {
      if (!store.selection.has(note.id)) setSelection([note.id]);
      const step = store.snapEnabled ? gridPpq.value : 0;
      const splitPpq = step > 0 ? snapPianoRollPpq(payload.ppq) : payload.ppq;
      const canSplit = splitPpq > note.startPpq && splitPpq < note.startPpq + note.durationPpq;
      items.push(
        {
          id: 'split',
          label: t.value.shell.pianoRoll.context.splitHere,
          hint: '3',
          disabled: contentReadOnly.value || !canSplit,
          run: () => setSelection([splitNote(note.id, splitPpq)]),
        },
        { id: 'sep-clipboard', separator: true },
        {
          id: 'copy',
          label: t.value.shell.pianoRoll.context.copy,
          hint: '⌘C',
          run: () => copySelectedNotes(),
        },
        {
          id: 'cut',
          label: t.value.shell.pianoRoll.context.cut,
          hint: '⌘X',
          disabled: contentReadOnly.value,
          run: () => cutSelectedNotes(),
        },
        {
          id: 'paste',
          label: t.value.shell.pianoRoll.context.paste,
          hint: '⌘V',
          disabled: contentReadOnly.value,
          run: pasteAtCursor,
        },
        { id: 'sep-selection', separator: true },
        ...selectionOpItems(),
        { id: 'sep-1', separator: true },
        {
          id: 'delete',
          label: t.value.shell.pianoRoll.context.delete,
          danger: true,
          hint: 'Del',
          disabled: contentReadOnly.value,
          run: () => deleteNotes([note.id]),
        },
      );
    }
  } else if (store.selection.size > 0) {
    items.push(
      {
        id: 'copy',
        label: t.value.shell.pianoRoll.context.copy,
        hint: '⌘C',
        run: () => copySelectedNotes(),
      },
      {
        id: 'cut',
        label: t.value.shell.pianoRoll.context.cut,
        hint: '⌘X',
        disabled: contentReadOnly.value,
        run: () => cutSelectedNotes(),
      },
      {
        id: 'paste',
        label: t.value.shell.pianoRoll.context.paste,
        hint: '⌘V',
        disabled: contentReadOnly.value,
        run: pasteAtCursor,
      },
      { id: 'sep-selection', separator: true },
      ...selectionOpItems(),
    );
  } else {
    items.push({
      id: 'paste',
      label: t.value.shell.pianoRoll.context.paste,
      hint: '⌘V',
      disabled: contentReadOnly.value,
      run: pasteAtCursor,
    });
  }
  openContextMenu(payload.x, payload.y, items);
}

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
    updateNotes([
      {
        id: note.id,
        durationPpq: Math.min(maximum - note.startPpq, Math.max(0.0625, note.durationPpq + delta)),
      },
    ]);
  } else {
    updateNotes([
      {
        id: note.id,
        startPpq: Math.min(maximum - note.durationPpq, Math.max(minimum, note.startPpq + delta)),
      },
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

/** Maps a clip-source ruler seek back to an absolute transport PPQ. */
function onRulerSeek(localPpq: number): void {
  emit('seek', Math.max(0, localPpq + timeSignatureOriginPpq.value));
}

const localTimeSignatures = computed(() =>
  localizeMeter(store.timeSignatures, timeSignatureOriginPpq.value),
);
const snapPianoRollPpq = (ppq: number): number =>
  snapPpqToMeterGrid(localTimeSignatures.value, ppq, store.snapBar ? 'bar' : gridPpq.value);

/** Moves a piano-roll position to the adjacent real bar boundary in Bar mode. */
function barKeyboardDelta(ppq: number, direction: 'left' | 'right', coarse: boolean): number {
  let cursor = Math.max(0, ppq);
  const steps = coarse ? 4 : 1;
  for (let index = 0; index < steps; index += 1) {
    const current = measureRangeAt(localTimeSignatures.value, cursor);
    if (direction === 'right') {
      cursor = current.startPpq + current.lengthPpq;
      continue;
    }
    cursor =
      cursor > current.startPpq + 1e-9
        ? current.startPpq
        : measureRangeAt(localTimeSignatures.value, Math.max(0, cursor - 1e-6)).startPpq;
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

const interactions = useNoteInteractions({
  view: range,
  getNotes: () => audibleSourceNotes.value,
  getSelection: () => store.selection,
  // A non-positive step disables snapping in the gesture state machine while
  // the drawn gridlines keep following the configured division.
  getGridPpq: () => (store.snapEnabled ? gridPpq.value : 0),
  snapPpq: snapPianoRollPpq,
  getTool: () => tool.value,
  isReadOnly: () => contentReadOnly.value,
  getMinPpq: () => sourceWindowStartPpq.value,
  getMaxPpq: () => sourceWindowEndPpq.value,
  resolveCreatedPitch: resolveScalePitch,
  resolveEditedPitch: resolveScalePitch,
  getCreatedChannel: () => preferredNoteChannel(store.activeTrack, activeTrackNotes.value),
  commands: { addNote, addNotes, updateNotes, deleteNotes, setSelection, splitNote },
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
  const selected = store.selectedNotes;
  if (selected.length === 0) return false;
  const step = store.snapEnabled ? gridPpq.value : 0.0625;
  let updates: Parameters<typeof updateNotes>[0] = [];
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const direction = event.key === 'ArrowLeft' ? 'left' : 'right';
    const minStart = Math.min(...selected.map((note) => note.startPpq));
    const maxEnd = Math.max(...selected.map((note) => note.startPpq + note.durationPpq));
    const requestedDelta =
      store.snapEnabled && store.snapBar
        ? barKeyboardDelta(minStart, direction, event.shiftKey)
        : direction === 'left'
          ? -step
          : step;
    const delta = Math.min(
      sourceWindowEndPpq.value - maxEnd,
      Math.max(sourceWindowStartPpq.value - minStart, requestedDelta),
    );
    if (event.altKey) {
      const ids = addNotes(
        selected.map((note) => ({
          pitch: note.pitch,
          startPpq: Math.max(sourceWindowStartPpq.value, note.startPpq + delta),
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
        startPpq: Math.max(sourceWindowStartPpq.value, note.startPpq + delta),
      }));
    }
  } else if (event.key === '[' || event.key === ']') {
    const delta = event.key === '[' ? -step : step;
    updates = selected.map((note) => ({
      id: note.id,
      durationPpq: Math.min(
        sourceWindowEndPpq.value - note.startPpq,
        Math.max(0.0625, note.durationPpq + delta),
      ),
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
  const location = pianoRollStatusLocation(localTimeSignatures.value, hover.ppq);
  return `${prefix}${formatPitch(hover.pitch)} · ${location.bar}.${location.beat} · ${hover.ppq.toFixed(3)} ppq · ${selection} selected · Snap ${snap}`;
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
    const nextStart = anchoredPlayheadFollowStart(range, ppq, PLAYHEAD_ANCHOR_LOCAL_X);
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

/** Local column the overlay pins the playhead to while following, else null. */
function followAnchorLocalX(): number | null {
  return props.isPlaying && appSettings.settings.scrollFollowPlayhead
    ? PLAYHEAD_ANCHOR_LOCAL_X
    : null;
}

watch(
  () => [props.isPlaying, appSettings.settings.scrollFollowPlayhead],
  ([playing, follow]) => {
    if (playing && follow) startPlayheadFollow();
    else stopPlayheadFollow();
  },
);

// A seek while stopped nudges nothing else horizontally, so scroll the sought
// position back into view when it lands outside the viewport. During playback
// the follow loop owns scrolling, so skip it there.
watch(
  () => (props.positionPpq ? localPositionPpq() : undefined),
  (ppq) => {
    if (props.isPlaying || ppq === undefined) return;
    const nextStart = revealPlayheadStart(range, ppq, PLAYHEAD_ANCHOR_LOCAL_X);
    if (nextStart !== null) {
      range.setStartPpq(nextStart);
      bump();
    }
  },
);

onMounted(() => {
  if (props.isPlaying && appSettings.settings.scrollFollowPlayhead) startPlayheadFollow();
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
        :time-signatures="localTimeSignatures"
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
  /* Columns are set inline from KEYBOARD_COLUMN_WIDTH_PX so the keyboard width
     and the playhead follow anchor stay derived from one source. */
  /* The parameter lane yields space to the note grid on shorter screens. A
     fixed 132px lane collapses the playable grid entirely at 720px height. */
  grid-template-rows: 18px 24px 18px minmax(0, 1fr) clamp(48px, 25%, 132px) 12px 22px;
}

/* Collapse the parameter-lane row when the user hides the block; the grid and
 * scrollbars keep the full remaining height. The lane cells are removed from
 * layout so their canvases stop sizing/painting while hidden. */
.piano-roll-layout.lane-hidden {
  grid-template-rows: 18px 24px 18px 1fr 0 12px 22px;
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

.cell-chord-corner {
  grid-area: 3 / 1;
  display: flex;
  align-items: center;
  padding: 0 var(--sp-2);
  background: var(--surface-2);
  border-bottom: 1px solid var(--border-strong);
  font: var(--fw-semibold) var(--fs-chrome-md) var(--font-sans);
  letter-spacing: 0.06em;
  color: var(--text-4);
  overflow: hidden;
}

.cell-chords {
  grid-area: 3 / 2;
  min-width: 0;
}

.cell-chord-spacer {
  grid-area: 3 / 3;
  background: var(--surface-2);
}

.cell-keyboard {
  grid-area: 4 / 1;
}

.cell-grid {
  grid-area: 4 / 2;
  position: relative;
  min-width: 0;
  min-height: 0;
}

.cell-vscroll {
  grid-area: 4 / 3;
}

.cell-velocity-label {
  grid-area: 5 / 1;
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

.lane-divider {
  flex: none;
  height: 1px;
  margin: 1px 4px;
  background: var(--border);
}

/* Keep the channel picker from stretching as a flex item in the lane column;
 * the frosted trigger carries its own surface, padding and typography. */
.lane-channel,
.lane-curve {
  flex: none;
  min-height: 0;
}

.lane-mode-select {
  flex: none;
  min-width: 0;
}

.mpe-unsupported-note {
  margin: 2px 3px;
  color: var(--text-3);
  font: var(--fs-2xs) var(--font-sans);
  line-height: 1.25;
}

.cell-velocity {
  grid-area: 5 / 2;
  border-top: 1px solid var(--border-strong);
}

.cell-corner {
  grid-area: 5 / 3;
  background: var(--surface-2);
}

.cell-hscroll-spacer {
  grid-area: 6 / 1;
  background: var(--surface-2);
}

.cell-hscroll {
  grid-area: 6 / 2;
}

.cell-corner-br {
  grid-area: 6 / 3;
  background: var(--surface-2);
}

.cell-status {
  grid-area: 7 / 1 / 8 / 4;
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
