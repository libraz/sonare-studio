<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { promptDialog } from '@/composables/useDialogs';
import { useEditorTool } from '@/composables/useEditorTool';
import { useFileDownloads } from '@/composables/useFileDownloads';
import { buildKeyMap } from '@/compose/key-map';
import { ensureWasm } from '@/lib/wasm';
import { loadAsset } from '@/persistence/assets';
import { TuneToMidiRefusedError } from '@/project/audio-tune-to-midi';
import type { AutomationParam } from '@/project/automation';
import {
  type CrossfadeBlockReason,
  crossfadePartner,
  DEFAULT_CLIP_CROSSFADE_PPQ,
  planClipCrossfade,
} from '@/project/clip-crossfade';
import { clipSplitBlockReason } from '@/project/clip-split';
import {
  addMidiClip,
  applyGrooveToActiveClip,
  captureGrooveFromActiveClip,
  clearActiveClipSelection,
  consolidateAudioClips,
  copyActiveClip,
  crossfadeClips,
  cutActiveClip,
  deleteClip,
  deleteTime,
  detectSectionsFromArrangement,
  detectSectionsFromAudioClip,
  duplicateClip,
  extractMelodyFromAudioClip,
  glueMidiClips,
  insertTime,
  moveClip,
  moveClips,
  pasteClipAt,
  renameClip,
  setActiveClip,
  setAutomationLanePoints,
  setClipActiveTake,
  setClipCompSegments,
  setClipFades,
  setClipLoop,
  setClipMidiActiveTake,
  setClipMidiCompSegments,
  setClipSelection,
  setMarker,
  sliceAudioClipAtTransients,
  splitAudioClipToStems,
  splitClip,
  type TrackPart,
  trimClip,
  tuneAudioClipToMidiTrack,
} from '@/project/commands';
import { exportClipSmf } from '@/project/export';
import { unfreezeTrack } from '@/project/freeze';
import { grooveTemplateIsUsable } from '@/project/groove';
import { useProjectStore } from '@/project/store';
import { normalizeTempoMap } from '@/project/tempo-map';
import { snapPpqToMeterGrid } from '@/project/time-signature';
import { canTrackContainClip, clipKind, isAudioClip } from '@/project/types';
import type { AccessibleObjectAdjustment } from '@/ui/accessibility/object-navigation';
import { assetLengthPpq, audioClipSourceBounds } from '@/ui/arrangement/audio-clip-content';
import { getLoadedAudioAsset } from '@/ui/arrangement/audio-clip-data';
import {
  AUTOMATION_LANE_HEIGHT_PX,
  automationLaneDomain,
  buildRowLayout,
  trackTakeRowCount,
} from '@/ui/arrangement/automation-rows';
import { visibleGroupRows } from '@/ui/arrangement/group-rows';
import {
  anchoredPlayheadFollowStart,
  PLAYHEAD_FOLLOW_ANCHOR_X,
  revealPlayheadStart,
} from '@/ui/arrangement/playhead-follow';
import { barRangeAt } from '@/ui/arrangement/ruler';
import { useAutomationInteractions } from '@/ui/arrangement/use-automation-interactions';
import {
  type ClipInteractionsView,
  useClipInteractions,
} from '@/ui/arrangement/use-clip-interactions';
import { useCommonTakeSilence } from '@/ui/arrangement/use-common-take-silence';
import { useTakeInteractions } from '@/ui/arrangement/use-take-interactions';
import { createPainter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';
import { formatMessage, useI18n } from '@/ui/i18n';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';
import { SNAP_CHOICES } from '@/ui/shell/app-shell-options';
import type { NoteTargetUnmatchedPolicy } from '@/wasm/index.js';
import ArrangementAnalysisPanel from './ArrangementAnalysisPanel.vue';
import ArrangementCanvas from './ArrangementCanvas.vue';
import ChordLane from './ChordLane.vue';
import SectionLane from './SectionLane.vue';
import TrackHeaderList from './TrackHeaderList.vue';
import {
  CHORD_LANE_HEIGHT_PX,
  LANE_HEIGHT_PX,
  RULER_HEIGHT_PX,
  SECTION_LANE_HEIGHT_PX,
  TRACK_HEADER_WIDTH_PX,
} from './theme';

/**
 * Arrangement (timeline) view: section lane on top, track header column on
 * the left and the clip canvas (with its bar/beat ruler) in the center, all
 * sharing one TimelineRange for horizontal pan/zoom and one vertical scroll
 * offset for the track lanes.
 *
 * All arrangement edits go through src/project/commands.ts; the project store
 * is the read model. Selecting a clip activates its track and clip so the
 * piano roll follows. The optional `positionPpq` getter drives the playhead;
 * seek requests (ruler press, section click) are emitted to the shell.
 *
 * Automation sublane expansion, the per-track parameter choice and take
 * sub-row expansion are view-local state owned here and mirrored into both
 * the header column and the canvas so their row geometry stays in lockstep.
 */

const props = defineProps<{
  /** Playhead position getter in PPQ; omit to hide the playhead. */
  positionPpq?: () => number;
  /** True while the transport is playing; enables playhead follow scrolling. */
  isPlaying?: boolean;
  /** Whether the transport loop is enabled (shown on the ruler). */
  loopEnabled?: boolean;
  /** Transport loop start in PPQ. */
  loopStartPpq?: number;
  /** Transport loop end in PPQ. */
  loopEndPpq?: number;
  /** Ids of record-armed tracks (recording state is owned by the shell). */
  armedTrackIds?: readonly number[];
  /** Available audioinput devices for the per-track record-device picker. */
  recordInputDevices?: readonly { value: string; label: string }[];
}>();

const emit = defineEmits<{
  /** Request to move the transport playhead to an absolute PPQ position. */
  seek: [ppq: number];
  /** Request to set and enable a loop range. */
  loopRange: [startPpq: number, endPpq: number];
  /** Request to (dis)arm a track for recording (re-emitted from the headers). */
  arm: [trackId: number, armed: boolean];
  /** Request to open a MIDI track's instrument picker. */
  changeInstrument: [trackId: number];
  /** Request to regenerate a track by replacing it (track-header context menu). */
  regenerateTrack: [trackId: number, part: TrackPart];
  /** Request to open the music-generation dialog (chord-lane corner button). */
  generate: [];
  /** Request to reveal the chord list editor (chord-lane double-click). */
  openChords: [];
}>();

const appSettings = useAppSettings();
const store = useProjectStore();
const { t } = useI18n();
const snapChoice = computed<number | 'bar'>({
  get: () => (store.snapBar ? 'bar' : store.snapDivision),
  set: (value) => {
    store.snapBar = value === 'bar';
    if (value !== 'bar') store.snapDivision = value;
  },
});
const { downloadBlobFile } = useFileDownloads();
/** The project's key timeline, read by the chord lane's harmonic analysis. */
const arrangementKeyMap = computed(() => buildKeyMap(store.scaleHighlight, store.markers));

/** Initialization/runtime error surfaced above the view. */
const error = ref('');

/** True while a section detection is awaiting the engine. */
const isDetectingSections = ref(false);

/** True while a melody extraction is awaiting the engine. */
const isExtractingMelody = ref(false);

/** True while a stem separation is awaiting the engine. */
const isSplittingStems = ref(false);

/** True while a clip is being tuned to a MIDI track. */
const isTuningToMidi = ref(false);

/** Result line of the last tuning, shown until the next action. */
const notice = ref('');

/** The active clip when it is an audio clip carrying an asset, else null. */
const detectableAudioClip = computed(() => {
  const clip = store.activeClip;
  return clip && isAudioClip(clip) && clip.assetId !== undefined ? clip : null;
});

/** Whether any track carries audible content (notes or audio) yet. */
const hasContent = computed(() =>
  store.clips.some((clip) => clip.notes.length > 0 || isAudioClip(clip)),
);

/** Whether any clip carries written notes the form could be read from. */
const hasWrittenNotes = computed(() => store.clips.some((clip) => clip.notes.length > 0));

/**
 * Reads the song form from the written notes across the whole arrangement and
 * replaces the section lane with it. Unlike {@link detectSections} this needs no
 * audio and asserts only which spans restate which, labelling them A, B, C.
 */
function sectionsFromNotes(): void {
  if (!hasWrittenNotes.value) return;
  error.value = '';
  const summary = detectSectionsFromArrangement();
  if (summary.count === 0) error.value = t.value.shell.arrangement.noSectionsFromNotes;
}

/**
 * Detects song sections from the active audio clip and merges them into the
 * section lane. Surfaces an error when analysis fails or finds nothing.
 */
function detectSections(): void {
  const clip = detectableAudioClip.value;
  if (!clip || isDetectingSections.value) return;
  error.value = '';
  isDetectingSections.value = true;
  void (async () => {
    try {
      const count = await detectSectionsFromAudioClip(clip.id);
      if (count === 0) error.value = t.value.shell.arrangement.noSectionsDetected;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      isDetectingSections.value = false;
    }
  })();
}

/**
 * Transcribes the active audio clip's melody to a new MIDI clip/track. Surfaces
 * an error when analysis fails or finds no notes.
 */
function extractMelody(): void {
  const clip = detectableAudioClip.value;
  if (!clip || isExtractingMelody.value) return;
  error.value = '';
  isExtractingMelody.value = true;
  void (async () => {
    try {
      const newClipId = await extractMelodyFromAudioClip(clip.id);
      if (newClipId < 0) error.value = t.value.shell.arrangement.noMelodyDetected;
      else setActiveClip(newClipId);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      isExtractingMelody.value = false;
    }
  })();
}

/**
 * Splits the active audio clip into harmonic/percussive/residual stems, each on
 * a new audio track. Surfaces an error when separation is unavailable or finds
 * no audible window.
 */
function splitToStems(): void {
  const clip = detectableAudioClip.value;
  if (!clip || isSplittingStems.value) return;
  error.value = '';
  isSplittingStems.value = true;
  void (async () => {
    try {
      const newClipIds = await splitAudioClipToStems(clip.id);
      if (newClipIds.length === 0) error.value = t.value.shell.arrangement.noStemsSeparated;
      else setActiveClip(newClipIds[0]);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      isSplittingStems.value = false;
    }
  })();
}

/** MIDI tracks a clip can be tuned to. */
const midiTracks = computed(() => store.tracks.filter((track) => track.kind === 'midi'));

/** Unmatched-note policies offered per reference track, safest first. */
const TUNE_POLICIES: ReadonlyArray<NoteTargetUnmatchedPolicy> = ['leave', 'mute', 'nearest'];

/** Opens the reference-track menu for tuning the active audio clip to MIDI. */
function openTuneToMidiMenu(event: MouseEvent): void {
  const clip = detectableAudioClip.value;
  if (!clip || isTuningToMidi.value) return;
  const items: ContextMenuItem[] = midiTracks.value.map((track) => ({
    id: `tune-${track.id}`,
    label: track.name,
    children: TUNE_POLICIES.map((policy) => ({
      id: `tune-${track.id}-${policy}`,
      label: t.value.shell.arrangement.tuneToMidiPolicy[policy],
      run: () => tuneToMidi(clip.id, track.id, track.name, policy),
    })),
  }));
  openContextMenu(event.clientX, event.clientY, items);
}

/** Tunes one audio clip to a MIDI track and reports how many notes matched. */
function tuneToMidi(
  clipId: number,
  trackId: number,
  trackName: string,
  policy: NoteTargetUnmatchedPolicy,
): void {
  error.value = '';
  notice.value = '';
  isTuningToMidi.value = true;
  void (async () => {
    try {
      const outcome = await tuneAudioClipToMidiTrack(clipId, trackId, policy);
      if (!outcome) return;
      setActiveClip(outcome.clipId);
      notice.value = formatMessage(t.value.shell.arrangement.tunedToMidi, {
        assigned: outcome.assignedCount,
        total: outcome.noteCount,
        track: trackName,
      });
    } catch (err) {
      error.value =
        err instanceof TuneToMidiRefusedError
          ? formatMessage(t.value.shell.arrangement.tuneToMidiRefused[err.reason], {
              track: trackName,
            })
          : err instanceof Error
            ? err.message
            : String(err);
    } finally {
      isTuningToMidi.value = false;
    }
  })();
}

/** Default horizontal zoom in px per quarter note (one 4/4 bar = 40 px). */
const DEFAULT_PX_PER_PPQ = 10;
/** Wheel-to-zoom sensitivity for ⌘wheel / pinch gestures. */
const ZOOM_WHEEL_SENSITIVITY = 0.0035;
/** Per-click multiplier for the arrangement's vertical track zoom. */
const VERTICAL_ZOOM_STEP = 1.2;
/** Bounds that keep compact overviews useful without making clips illegible. */
const MIN_LANE_HEIGHT_PX = 28;
const MAX_LANE_HEIGHT_PX = 112;

/** Per-frame horizontal follow interpolation for arrangement playback. */
const PLAYHEAD_FOLLOW_SMOOTHING = 0.42;
/** Small PPQ threshold below which snapping avoids endless tiny repaints. */
const PLAYHEAD_FOLLOW_EPSILON_PPQ = 0.0005;
/** Follow scrolling redraws the full arrangement base layer, so cap it below display refresh. */
const PLAYHEAD_FOLLOW_INTERVAL_MS = 33;
/** Ignore sub-pixel follow movement; the overlay playhead still updates every frame. */
const PLAYHEAD_FOLLOW_MIN_PX = 1;
/** Local column the playhead is pinned to while following (past the header). */
const PLAYHEAD_ANCHOR_LOCAL_X = Math.max(0, PLAYHEAD_FOLLOW_ANCHOR_X - TRACK_HEADER_WIDTH_PX);

// The TimelineRange and painter are plain (non-reactive) objects; views are
// invalidated through the `revision` counter after every range mutation.
const range = markRaw(new TimelineRange({ widthPx: 1, heightPx: 1, pxPerPpq: DEFAULT_PX_PER_PPQ }));
const painter = markRaw(createPainter());

/** Bumped after any TimelineRange or scroll mutation to trigger redraws. */
const revision = ref(0);

function bump(): void {
  revision.value++;
}

/** Vertical scroll offset of the track lanes in px (shared with the headers). */
const scrollY = ref(0);
/** View-local track-row height, shared by the canvas and track-header column. */
const laneHeight = ref(LANE_HEIGHT_PX);

// --- Automation sublane state ----------------------------------------------

/** Ids of tracks whose automation sublane is expanded (view-local state). */
const automationExpandedIds = ref<number[]>([]);

/** Selected automation parameter per track id (absent = 'faderDb'). */
const automationParams = ref<Record<number, AutomationParam>>({});

/** Ids of tracks whose take sub-rows are expanded (view-local state). */
const takesExpandedIds = ref<number[]>([]);

/** Group tracks whose member rows are hidden in this arrangement view. */
const collapsedGroupIds = ref<number[]>([]);

/** Tracks participating in the current visual row layout. */
const visibleTracks = computed(() => {
  return visibleGroupRows(store.tracks, new Set(collapsedGroupIds.value));
});

/** Clips drawn and hit-tested in the currently visible track rows. */
const visibleClips = computed(() => {
  const ids = new Set(visibleTracks.value.map((track) => track.id));
  return store.clips.filter((clip) => ids.has(clip.trackId));
});

/** Row layout reflecting which tracks show take sub-rows or an automation sublane. */
const rowLayout = computed(() => {
  const expanded = new Set(automationExpandedIds.value);
  const takesExpanded = new Set(takesExpandedIds.value);
  return buildRowLayout(
    visibleTracks.value.map((track) => expanded.has(track.id)),
    laneHeight.value,
    AUTOMATION_LANE_HEIGHT_PX,
    visibleTracks.value.map((track) =>
      takesExpanded.has(track.id) ? trackTakeRowCount(store.clips, track.id) : 0,
    ),
  );
});

function onToggleGroupCollapse(trackId: number, collapsed: boolean): void {
  const ids = collapsedGroupIds.value.filter((id) => id !== trackId);
  if (collapsed) ids.push(trackId);
  collapsedGroupIds.value = ids;
  scrollY.value = clampScrollY(scrollY.value);
  bump();
}

watch(
  () => store.tracks.map((track) => ({ id: track.id, kind: track.kind })),
  (tracks) => {
    const groupIds = new Set(
      tracks.filter((track) => track.kind === 'group').map((track) => track.id),
    );
    const next = collapsedGroupIds.value.filter((id) => groupIds.has(id));
    if (next.length !== collapsedGroupIds.value.length) collapsedGroupIds.value = next;
  },
);

function onToggleAutomation(trackId: number, expanded: boolean): void {
  const ids = automationExpandedIds.value.filter((id) => id !== trackId);
  if (expanded) ids.push(trackId);
  automationExpandedIds.value = ids;
  // Collapsing shrinks the content extent below the current scroll offset.
  scrollY.value = clampScrollY(scrollY.value);
  bump();
}

function onAutomationParamChange(trackId: number, param: AutomationParam): void {
  automationParams.value = { ...automationParams.value, [trackId]: param };
}

function onToggleTakes(trackId: number, expanded: boolean): void {
  const ids = takesExpandedIds.value.filter((id) => id !== trackId);
  if (expanded) ids.push(trackId);
  takesExpandedIds.value = ids;
  // Collapsing shrinks the content extent below the current scroll offset.
  scrollY.value = clampScrollY(scrollY.value);
  bump();
}

/** Clamps the lane scroll offset to the track content extent. */
function clampScrollY(y: number): number {
  const viewport = Math.max(0, range.heightPx - RULER_HEIGHT_PX);
  const content = rowLayout.value.totalHeight;
  return Math.min(Math.max(0, content - viewport), Math.max(0, y));
}

/** Snap grid step in PPQ derived from the store (0 when snapping is off). */
const gridPpq = computed(() => (store.snapEnabled ? 4 / store.snapDivision : 0));
const snapArrangementPpq = (ppq: number): number =>
  snapPpqToMeterGrid(store.timeSignatures, ppq, store.snapBar ? 'bar' : gridPpq.value);

/** Moves an arrangement position to the adjacent meter-defined bar boundary. */
function barKeyboardDelta(ppq: number, direction: 'left' | 'right', coarse: boolean): number {
  let cursor = Math.max(0, ppq);
  const steps = coarse ? 4 : 1;
  for (let index = 0; index < steps; index += 1) {
    const current = barRangeAt(store.timeSignatures, cursor);
    if (direction === 'right') {
      cursor = current.startPpq + current.lengthPpq;
      continue;
    }
    cursor =
      cursor > current.startPpq + 1e-9
        ? current.startPpq
        : barRangeAt(store.timeSignatures, Math.max(0, cursor - 1e-6)).startPpq;
  }
  return cursor - ppq;
}

// Lane view contract for the clip gestures: horizontal mapping from the
// shared range, vertical mapping from the row layout and scroll offset.
// Clips occupy a row's track zone, so laneHeight stays the plain lane height
// while row tops follow the prefix sums (expanded sublanes shift rows down).
const laneView: ClipInteractionsView = {
  ppqToX: (ppq) => range.ppqToX(ppq),
  xToPpq: (x) => range.xToPpq(x),
  laneTop: (index) => RULER_HEIGHT_PX + rowLayout.value.rowTop(index) - scrollY.value,
  laneIndexAtY: (y) => {
    const contentY = y - RULER_HEIGHT_PX + scrollY.value;
    if (contentY < 0) return Math.floor(contentY / laneHeight.value);
    const hit = rowLayout.value.hitTest(contentY);
    return hit ? hit.index : visibleTracks.value.length;
  },
  get laneHeight() {
    return laneHeight.value;
  },
  get laneCount() {
    return visibleTracks.value.length;
  },
};

/**
 * Trim bounds of a non-looping audio clip against its backing asset; null
 * (unbounded) for MIDI clips, looping clips and assets not yet loaded.
 */
function sourceBoundsFor(clipId: number) {
  const clip = store.clips.find((c) => c.id === clipId);
  if (!clip || !isAudioClip(clip) || !clip.assetId || clip.loopEnabled) return null;
  const asset = getLoadedAudioAsset(clip.assetId);
  if (!asset) return null;
  const assetPpq = assetLengthPpq(
    asset.meta.numFrames,
    asset.meta.sampleRate,
    normalizeTempoMap(store.tempoSegments, store.tempoBpm),
    clip.startPpq - clip.sourceOffsetPpq,
  );
  return audioClipSourceBounds(clip, assetPpq);
}

const { tool } = useEditorTool();

const interactions = useClipInteractions({
  view: laneView,
  getClips: () => visibleClips.value,
  getTrackIds: () => visibleTracks.value.map((track) => track.id),
  canMoveClipToTrack: (clipId, trackId) => {
    const clip = store.clips.find((entry) => entry.id === clipId);
    const track = store.tracks.find((entry) => entry.id === trackId);
    return Boolean(
      clip &&
        track &&
        track.frozen === undefined &&
        canTrackContainClip(track.kind, clipKind(clip)),
    );
  },
  canEditClip: (clipId) => {
    const clip = store.clips.find((entry) => entry.id === clipId);
    return store.tracks.find((track) => track.id === clip?.trackId)?.frozen === undefined;
  },
  canEditTrack: (trackId) =>
    store.tracks.find((track) => track.id === trackId)?.frozen === undefined,
  getGridPpq: () => gridPpq.value,
  getSelectedClipIds: () => store.clipSelection,
  snapPpq: snapArrangementPpq,
  getBarRange: (ppq) => barRangeAt(store.timeSignatures, ppq),
  getSourceBounds: sourceBoundsFor,
  getTool: () => tool.value,
  onSplitBlocked: (_clipId, reason) => {
    if (reason === 'loop') error.value = t.value.shell.arrangement.loopSplitUnavailable;
  },
  commands: {
    selectClip: (clipId) => setActiveClip(clipId),
    selectClips: (clipIds, activeClipId) => setClipSelection(clipIds, activeClipId),
    clearClipSelection: (trackId) => clearActiveClipSelection(trackId),
    moveClip,
    moveClips,
    trimClip,
    duplicateClip,
    // Double-click and draw-tool creation make empty MIDI clips; audio clips
    // come from imports/recording, so audio (and aux) lanes do not create.
    createClip: (trackId, startPpq, lengthPpq) => {
      const track = store.tracks.find((t) => t.id === trackId);
      if (track?.kind !== 'midi') return null;
      return addMidiClip({ trackId, startPpq, lengthPpq });
    },
    setClipFades,
    deleteClip,
    splitClip,
  },
});

const automation = useAutomationInteractions({
  view: {
    ppqToX: (ppq) => range.ppqToX(ppq),
    xToPpq: (x) => range.xToPpq(x),
    sublaneAt: (point) => {
      if (point.y < RULER_HEIGHT_PX) return null;
      const hit = rowLayout.value.hitTest(point.y - RULER_HEIGHT_PX + scrollY.value);
      if (hit?.zone !== 'automation') return null;
      const track = visibleTracks.value[hit.index];
      const param = automationParams.value[track.id] ?? 'faderDb';
      const insertDomain = automationLaneDomain(track.mixer, param);
      return {
        trackId: track.id,
        param,
        top: RULER_HEIGHT_PX + rowLayout.value.automationTop(hit.index) - scrollY.value,
        height: AUTOMATION_LANE_HEIGHT_PX,
        ...(insertDomain ? { insertDomain } : {}),
      };
    },
  },
  getLanePoints: (trackId, param) =>
    store.automationLanes.find((lane) => lane.target === trackId && lane.param === param)?.points ??
    [],
  getGridPpq: () => gridPpq.value,
  snapPpq: snapArrangementPpq,
  commands: {
    setPoints: (trackId, param, points) => setAutomationLanePoints(trackId, param, points),
  },
});

/** Silence every take of an open comped clip shares, for drawing and edge snapping. */
const takeSilence = useCommonTakeSilence({
  clips: () => store.clips,
  expandedTrackIds: () => takesExpandedIds.value,
  tempo: () => normalizeTempoMap(store.tempoSegments, store.tempoBpm),
  deps: async () => {
    const wasm = await ensureWasm();
    return {
      loadAudioAsset: loadAsset,
      splitSilenceCommon: (signals) => wasm.splitSilenceCommon({ signals }),
    };
  },
});

const takes = useTakeInteractions({
  view: {
    ppqToX: (ppq) => range.ppqToX(ppq),
    xToPpq: (x) => range.xToPpq(x),
    takeRowAt: (point) => {
      if (point.y < RULER_HEIGHT_PX) return null;
      const hit = rowLayout.value.hitTest(point.y - RULER_HEIGHT_PX + scrollY.value);
      if (hit?.zone !== 'take' || hit.takeIndex === undefined) return null;
      return { trackId: visibleTracks.value[hit.index].id, takeIndex: hit.takeIndex };
    },
  },
  getClips: () => store.clips,
  canEditTrack: (trackId) =>
    store.tracks.find((track) => track.id === trackId)?.frozen === undefined,
  commands: {
    setActiveTake: setClipActiveTake,
    setCompSegments: setClipCompSegments,
    setActiveMidiTake: setClipMidiActiveTake,
    setMidiCompSegments: setClipMidiCompSegments,
  },
  snapEdge: takeSilence.snapEdge,
});

const canvasCell = ref<HTMLDivElement | null>(null);

function onWheel(event: WheelEvent): void {
  if (event.metaKey || event.ctrlKey) {
    const anchorEl =
      event.currentTarget instanceof HTMLElement ? event.currentTarget : canvasCell.value;
    if (!anchorEl) return;
    const anchorX = event.clientX - anchorEl.getBoundingClientRect().left;
    range.zoomAt(anchorX, Math.exp(-event.deltaY * ZOOM_WHEEL_SENSITIVITY));
  } else if (event.altKey) {
    zoomVertical(Math.exp(-event.deltaY * ZOOM_WHEEL_SENSITIVITY));
  } else if (event.shiftKey) {
    range.scrollByPx(event.deltaY + event.deltaX);
  } else {
    range.scrollByPx(event.deltaX);
    scrollY.value = clampScrollY(scrollY.value + event.deltaY);
  }
  bump();
}

/** Zooms the arrangement horizontally around its viewport center. */
function zoomHorizontal(factor: number): void {
  range.zoomAt(range.widthPx / 2, factor);
  bump();
}

/** Zooms track rows vertically while keeping the current viewport position stable. */
function zoomVertical(factor: number): void {
  const previous = laneHeight.value;
  const next = Math.min(
    MAX_LANE_HEIGHT_PX,
    Math.max(MIN_LANE_HEIGHT_PX, Math.round(previous * factor)),
  );
  if (next === previous) return;
  laneHeight.value = next;
  scrollY.value = clampScrollY(scrollY.value * (next / previous));
  bump();
}

/** Fits the full arranged clip range into the timeline viewport. */
function zoomToFit(): void {
  const endPpq = Math.max(4, ...store.clips.map((clip) => clip.startPpq + clip.lengthPpq));
  range.zoomAt(0, range.widthPx / endPpq / range.pxPerPpq);
  range.setStartPpq(0);
  bump();
}

function onCanvasResize(): void {
  scrollY.value = clampScrollY(scrollY.value);
  bump();
}

let followRaf: number | null = null;
let lastFollowFrameMs = 0;

function stopPlayheadFollow(): void {
  if (followRaf !== null) cancelAnimationFrame(followRaf);
  followRaf = null;
}

// Following pins the playhead at the right margin and then scrolls every frame
// to keep it there. Each scroll bumps `revision`, which repaints the whole base
// layer (lanes, grid, every clip waveform, take and automation sublanes, ruler)
// — far too costly at display refresh. Throttle the scroll to ~30 Hz, smooth it,
// and skip sub-pixel moves so the base repaint stays affordable; the overlay
// playhead still tracks every frame on its own cheap layer.
function followPlayheadTick(now = performance.now()): void {
  followRaf = null;
  if (!props.isPlaying || !appSettings.settings.scrollFollowPlayhead) return;
  if (now - lastFollowFrameMs < PLAYHEAD_FOLLOW_INTERVAL_MS) {
    followRaf = requestAnimationFrame(followPlayheadTick);
    return;
  }
  lastFollowFrameMs = now;
  const ppq = props.positionPpq?.();
  if (ppq !== undefined) {
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

function onSeek(ppq: number): void {
  emit('seek', ppq);
}

type ClipKeyboardAction =
  | { clipId: number; kind: 'select' }
  | { clipId: number; kind: 'adjust'; adjustment: AccessibleObjectAdjustment }
  | { clipId: number; kind: 'set'; controlId: string; value: number };

/** Applies virtual-list clip actions through the same undoable project commands as pointer edits. */
function onClipKeyboardAction(payload: ClipKeyboardAction): void {
  const clip = store.clips.find((item) => item.id === payload.clipId);
  if (!clip) return;
  setActiveClip(clip.id);
  if (payload.kind === 'select') return;
  const track = store.tracks.find((item) => item.id === clip.trackId);
  if (track?.frozen !== undefined) return;
  try {
    if (payload.kind === 'set') {
      if (payload.controlId === 'start') {
        moveClip(clip.id, Math.max(0, payload.value));
      } else if (payload.controlId === 'length') {
        const bounds = sourceBoundsFor(clip.id);
        const maximum = bounds ? bounds.maxEndPpq - clip.startPpq : Number.POSITIVE_INFINITY;
        trimClip(clip.id, clip.startPpq, Math.max(0.25, Math.min(maximum, payload.value)));
      }
      return;
    }
    const { direction, resize, coarse } = payload.adjustment;
    const step = Math.max(0.0625, gridPpq.value) * (coarse ? 4 : 1);
    if (direction === 'left' || direction === 'right') {
      const delta =
        store.snapEnabled && store.snapBar
          ? barKeyboardDelta(clip.startPpq, direction, coarse)
          : direction === 'left'
            ? -step
            : step;
      if (resize) {
        const bounds = sourceBoundsFor(clip.id);
        const maximum = bounds ? bounds.maxEndPpq - clip.startPpq : Number.POSITIVE_INFINITY;
        trimClip(clip.id, clip.startPpq, Math.max(0.25, Math.min(maximum, clip.lengthPpq + delta)));
      } else {
        moveClip(clip.id, Math.max(0, clip.startPpq + delta));
      }
      return;
    }
    const currentTrackIndex = store.tracks.findIndex((item) => item.id === clip.trackId);
    const trackDelta = direction === 'up' ? -1 : 1;
    for (
      let index = currentTrackIndex + trackDelta;
      index >= 0 && index < store.tracks.length;
      index += trackDelta
    ) {
      const destination = store.tracks[index];
      if (
        destination.frozen === undefined &&
        canTrackContainClip(destination.kind, clipKind(clip))
      ) {
        moveClip(clip.id, clip.startPpq, destination.id);
        break;
      }
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function glueClusterClipIds(clipId: number): number[] {
  const source = store.clips.find((clip) => clip.id === clipId);
  if (!source || isAudioClip(source)) return [];
  const candidates = store.clips
    .filter(
      (clip) =>
        clip.trackId === source.trackId && !isAudioClip(clip) && (clip.kind ?? 'midi') === 'midi',
    )
    .sort((a, b) => a.startPpq - b.startPpq || a.id - b.id);
  const sourceIndex = candidates.findIndex((clip) => clip.id === clipId);
  if (sourceIndex < 0) return [];
  const EPSILON = 1e-6;
  let first = sourceIndex;
  let last = sourceIndex;
  while (first > 0) {
    const prev = candidates[first - 1];
    const current = candidates[first];
    if (prev.startPpq + prev.lengthPpq + EPSILON < current.startPpq) break;
    first--;
  }
  while (last < candidates.length - 1) {
    const current = candidates[last];
    const next = candidates[last + 1];
    if (current.startPpq + current.lengthPpq + EPSILON < next.startPpq) break;
    last++;
  }
  return candidates.slice(first, last + 1).map((clip) => clip.id);
}

function audioConsolidateClipIds(clipId: number): number[] {
  const source = store.clips.find((clip) => clip.id === clipId);
  if (!source || !isAudioClip(source)) return [];
  const candidates = store.clips
    .filter((clip) => clip.trackId === source.trackId && isAudioClip(clip))
    .sort((a, b) => a.startPpq - b.startPpq || a.id - b.id);
  const sourceIndex = candidates.findIndex((clip) => clip.id === clipId);
  if (sourceIndex < 0) return [];
  const EPSILON = 1e-6;
  let first = sourceIndex;
  let last = sourceIndex;
  while (first > 0) {
    const prev = candidates[first - 1];
    const current = candidates[first];
    if (prev.startPpq + prev.lengthPpq + EPSILON < current.startPpq) break;
    first--;
  }
  while (last < candidates.length - 1) {
    const current = candidates[last];
    const next = candidates[last + 1];
    if (current.startPpq + current.lengthPpq + EPSILON < next.startPpq) break;
    last++;
  }
  return candidates.slice(first, last + 1).map((entry) => entry.id);
}

/**
 * Resolves the crossfade the clip's right edge would form: which clip it pairs
 * with and why it is unavailable, so the menu can show the reason instead of a
 * silently disabled action.
 */
function crossfadeStateFor(clipId: number): {
  partnerId: number | null;
  reason: CrossfadeBlockReason | null;
} {
  const clip = store.clips.find((entry) => entry.id === clipId);
  if (!clip) return { partnerId: null, reason: null };
  const partner = crossfadePartner(clip, store.clips);
  if (!partner) return { partnerId: null, reason: null };
  const plan = planClipCrossfade(clip, partner, crossfadeOptionsFor(clip, partner));
  return {
    partnerId: partner.id,
    reason: 'reason' in plan ? plan.reason : null,
  };
}

/** Default crossfade length and the source limit that lets touching clips overlap. */
function crossfadeOptionsFor(
  a: { id: number; startPpq: number },
  b: { id: number; startPpq: number },
): { lengthPpq: number; leftSourceEndPpq?: number } {
  const leftId = a.startPpq <= b.startPpq ? a.id : b.id;
  const bounds = sourceBoundsFor(leftId);
  return {
    lengthPpq: gridPpq.value > 0 ? gridPpq.value : DEFAULT_CLIP_CROSSFADE_PPQ,
    ...(bounds === null ? {} : { leftSourceEndPpq: bounds.maxEndPpq }),
  };
}

/** Localized explanation for a blocked crossfade. */
function crossfadeReasonText(reason: CrossfadeBlockReason): string {
  return t.value.shell.arrangement.clipActions.crossfadeReasons[reason];
}

/** Crossfades the clip with its right-hand neighbour, reporting refusals inline. */
function runCrossfade(clipId: number): void {
  const clip = store.clips.find((entry) => entry.id === clipId);
  if (!clip) return;
  const partner = crossfadePartner(clip, store.clips);
  if (!partner) return;
  try {
    crossfadeClips(clip.id, partner.id, crossfadeOptionsFor(clip, partner));
  } catch {
    const plan = planClipCrossfade(clip, partner, crossfadeOptionsFor(clip, partner));
    error.value = 'reason' in plan ? crossfadeReasonText(plan.reason) : '';
  }
}

/**
 * Cuts an audio clip at its transients, optionally snapping the slices to the
 * arrangement grid. Failures surface in the view's error line instead of
 * leaving the clip half-sliced (the command itself is atomic).
 */
async function runTransientSlice(clipId: number, quantize: boolean): Promise<void> {
  try {
    const ids = await sliceAudioClipAtTransients(clipId, {
      quantize,
      snap: snapArrangementPpq,
    });
    if (ids.length < 2) error.value = t.value.shell.arrangement.clipActions.sliceNoTransients;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function consolidateAudioCluster(clipIds: number[]): Promise<void> {
  const id = await consolidateAudioClips(clipIds);
  if (id !== null) setActiveClip(id);
}

/** Builds and opens the right-click menu for a clip (or an empty lane). */
function onClipContext(payload: {
  x: number;
  y: number;
  clipId: number | null;
  ppq: number;
}): void {
  const clip = payload.clipId === null ? null : store.clips.find((c) => c.id === payload.clipId);
  if (!clip) return;
  setActiveClip(clip.id);
  const end = clip.startPpq + clip.lengthPpq;
  const splitPpq = snapArrangementPpq(payload.ppq);
  const splitBlocked = clipSplitBlockReason(clip, splitPpq);
  const glueIds = glueClusterClipIds(clip.id);
  const consolidateIds = audioConsolidateClipIds(clip.id);
  const frozen = store.tracks.find((track) => track.id === clip.trackId)?.frozen !== undefined;
  const crossfade = crossfadeStateFor(clip.id);
  const items: ContextMenuItem[] = [
    ...(frozen
      ? [
          {
            id: 'unfreeze',
            label: t.value.shell.arrangement.trackHeader.unfreeze,
            run: () => unfreezeTrack(clip.trackId),
          },
          { id: 'sep-frozen', separator: true },
        ]
      : []),
    {
      id: 'split',
      label:
        splitBlocked === 'loop'
          ? `${t.value.shell.arrangement.splitHere} — ${t.value.shell.arrangement.loopSplitUnavailable}`
          : t.value.shell.arrangement.splitHere,
      hint: '3',
      disabled: frozen || splitBlocked !== null,
      run: () => setActiveClip(splitClip(clip.id, splitPpq)),
    },
    {
      id: 'duplicate',
      label: t.value.shell.arrangement.clipActions.duplicate,
      disabled: frozen,
      run: () => setActiveClip(duplicateClip(clip.id, end)),
    },
    { id: 'sep-clipboard', separator: true },
    {
      id: 'copy',
      label: t.value.shell.arrangement.clipActions.copy,
      hint: '⌘C',
      run: () => copyActiveClip(),
    },
    {
      id: 'cut',
      label: t.value.shell.arrangement.clipActions.cut,
      hint: '⌘X',
      disabled: frozen,
      run: () => cutActiveClip(),
    },
    {
      id: 'paste',
      label: t.value.shell.arrangement.clipActions.paste,
      hint: '⌘V',
      disabled: frozen,
      run: () => pasteClipAt(clip.trackId, Math.max(0, payload.ppq)),
    },
    { id: 'sep-clip-edit', separator: true },
    {
      id: 'glue',
      label: t.value.shell.arrangement.clipActions.glue,
      disabled: frozen || glueIds.length < 2,
      run: () => setActiveClip(glueMidiClips(glueIds)),
    },
    {
      id: 'consolidate-audio',
      label: t.value.shell.arrangement.clipActions.consolidateAudio,
      disabled: frozen || consolidateIds.length < 2,
      run: () => consolidateAudioCluster(consolidateIds),
    },
    {
      id: 'slice-transients',
      label: t.value.shell.arrangement.clipActions.sliceTransients,
      disabled: frozen || !isAudioClip(clip) || clip.loopEnabled,
      run: () => runTransientSlice(clip.id, false),
    },
    {
      id: 'slice-transients-quantize',
      label: t.value.shell.arrangement.clipActions.sliceTransientsQuantize,
      disabled: frozen || !isAudioClip(clip) || clip.loopEnabled,
      run: () => runTransientSlice(clip.id, true),
    },
    {
      id: 'crossfade',
      label:
        crossfade.reason === null
          ? t.value.shell.arrangement.clipActions.crossfade
          : `${t.value.shell.arrangement.clipActions.crossfade} — ${crossfadeReasonText(crossfade.reason)}`,
      disabled: frozen || crossfade.partnerId === null || crossfade.reason !== null,
      run: () => runCrossfade(clip.id),
    },
    {
      id: 'rename',
      label: t.value.shell.arrangement.clipActions.rename,
      disabled: frozen,
      run: () => renameClipFromPrompt(clip.id, clip.name),
    },
    {
      id: 'loop',
      label: clip.loopEnabled
        ? t.value.shell.arrangement.clipActions.disableLoop
        : t.value.shell.arrangement.clipActions.enableLoop,
      disabled: frozen,
      run: () => setClipLoop(clip.id, !clip.loopEnabled),
    },
  ];
  if (!isAudioClip(clip)) {
    items.push(
      { id: 'sep-groove', separator: true },
      {
        id: 'groove-capture',
        label: t.value.shell.arrangement.clipActions.grooveCapture,
        run: () => {
          store.grooveTemplate = captureGrooveFromActiveClip();
        },
      },
      {
        id: 'groove-apply',
        label: grooveTemplateIsUsable(store.grooveTemplate)
          ? t.value.shell.arrangement.clipActions.grooveApply
          : `${t.value.shell.arrangement.clipActions.grooveApply} — ${t.value.shell.pianoRoll.context.grooveEmpty}`,
        disabled: frozen || !grooveTemplateIsUsable(store.grooveTemplate),
        run: () => {
          const groove = store.grooveTemplate;
          if (groove) applyGrooveToActiveClip(groove, store.quantizeStrength);
        },
      },
      {
        id: 'export-midi',
        label: t.value.shell.arrangement.clipActions.exportMidi,
        run: () => exportClipToSmf(clip.id),
      },
    );
  }
  items.push(
    { id: 'sep-1', separator: true },
    {
      id: 'delete',
      label: t.value.shell.arrangement.clipActions.delete,
      danger: true,
      disabled: frozen,
      run: () => deleteClip(clip.id),
    },
  );
  openContextMenu(payload.x, payload.y, items);
}

/** Builds and opens the right-click menu for the bar/beat ruler. */
function onRulerContext(payload: { x: number; y: number; ppq: number }): void {
  const items: ContextMenuItem[] = [
    {
      id: 'marker',
      label: t.value.shell.arrangement.clipActions.addMarker,
      run: () => addMarkerFromPrompt(payload.ppq),
    },
    { id: 'sep-ripple', separator: true },
    {
      id: 'insert-time',
      label: t.value.shell.arrangement.clipActions.insertTime,
      run: () => rippleTimeFromPrompt('insert', payload.ppq),
    },
    {
      id: 'delete-time',
      label: t.value.shell.arrangement.clipActions.deleteTime,
      danger: true,
      run: () => rippleTimeFromPrompt('delete', payload.ppq),
    },
  ];
  openContextMenu(payload.x, payload.y, items);
}

/** Exports a single MIDI clip to a Standard MIDI File download. */
function exportClipToSmf(clipId: number): void {
  error.value = '';
  void (async () => {
    try {
      const result = await exportClipSmf(clipId);
      downloadBlobFile(
        new Blob([new Uint8Array(result.bytes)], { type: 'audio/midi' }),
        result.filename,
      );
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    }
  })();
}

/** Renames a clip via a prompt, ignoring an empty or unchanged name. */
async function renameClipFromPrompt(clipId: number, current: string): Promise<void> {
  const next = await promptDialog({
    title: t.value.shell.arrangement.clipActions.renameTitle,
    message: t.value.shell.arrangement.clipActions.renameMessage,
    defaultValue: current,
    placeholder: t.value.shell.arrangement.clipActions.clipName,
    confirmLabel: t.value.shell.arrangement.clipActions.renameConfirm,
  });
  if (next && next !== current) renameClip(clipId, next);
}

/** Adds a marker at a position via a prompt for its name. */
function addMarkerFromPrompt(ppq: number): void {
  void (async () => {
    const name = await promptDialog({
      title: t.value.shell.arrangement.clipActions.addMarkerTitle,
      message: t.value.shell.arrangement.clipActions.addMarkerMessage,
      defaultValue: t.value.shell.arrangement.clipActions.markerDefaultName,
      placeholder: t.value.shell.arrangement.clipActions.markerName,
      confirmLabel: t.value.shell.arrangement.clipActions.addMarkerConfirm,
    });
    if (name) setMarker(null, ppq, name);
  })();
}

/** Prompts for a PPQ duration and performs a ripple insert or delete at the ruler point. */
function rippleTimeFromPrompt(mode: 'insert' | 'delete', ppq: number): void {
  void (async () => {
    const range = barRangeAt(store.timeSignatures, ppq);
    const defaultLength = String(range.lengthPpq);
    const isInsert = mode === 'insert';
    const lengthText = await promptDialog({
      title: isInsert
        ? t.value.shell.arrangement.clipActions.insertTimeTitle
        : t.value.shell.arrangement.clipActions.deleteTimeTitle,
      message: isInsert
        ? t.value.shell.arrangement.clipActions.insertTimeMessage
        : t.value.shell.arrangement.clipActions.deleteTimeMessage,
      defaultValue: defaultLength,
      placeholder: t.value.shell.arrangement.clipActions.timeLength,
      confirmLabel: isInsert
        ? t.value.shell.arrangement.clipActions.insertTimeConfirm
        : t.value.shell.arrangement.clipActions.deleteTimeConfirm,
    });
    if (lengthText === null) return;
    const lengthPpq = Number(lengthText);
    if (!Number.isFinite(lengthPpq) || lengthPpq <= 0) {
      error.value = t.value.shell.arrangement.clipActions.invalidTimeLength;
      return;
    }
    try {
      if (isInsert) insertTime(ppq, lengthPpq);
      else deleteTime(ppq, ppq + lengthPpq);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    }
  })();
}

/**
 * Splits a clip at the playhead position: the active clip when the playhead
 * is strictly inside it, otherwise the first clip on the active track under
 * the playhead. No-op without a playhead getter or a matching clip. The shell
 * binds this to its key shortcut.
 */
function cutAtPlayhead(): void {
  const getter = props.positionPpq;
  if (!getter) return;
  const ppq = getter();
  const inside = (clip: { startPpq: number; lengthPpq: number }): boolean =>
    ppq > clip.startPpq && ppq < clip.startPpq + clip.lengthPpq;
  const active = store.activeClip;
  const target =
    active && inside(active)
      ? active
      : (store.clips.find((clip) => clip.trackId === store.activeTrackId && inside(clip)) ?? null);
  if (!target) return;
  if (clipSplitBlockReason(target, ppq) === 'loop') {
    error.value = t.value.shell.arrangement.loopSplitUnavailable;
    return;
  }
  try {
    splitClip(target.id, ppq);
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

defineExpose({ cutAtPlayhead, zoomHorizontal, zoomToFit });

// Track removal or take-lane changes (e.g. flattening a comp) can shrink the
// content extent below the current scroll.
watch(
  () => rowLayout.value.totalHeight,
  () => {
    scrollY.value = clampScrollY(scrollY.value);
    bump();
  },
);

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
  () => props.positionPpq?.(),
  (ppq) => {
    if (props.isPlaying || ppq === undefined) return;
    const nextStart = revealPlayheadStart(range, ppq, PLAYHEAD_ANCHOR_LOCAL_X);
    if (nextStart !== null) {
      range.setStartPpq(nextStart);
      bump();
    }
  },
);

onMounted(async () => {
  if (props.isPlaying && appSettings.settings.scrollFollowPlayhead) startPlayheadFollow();
  try {
    await store.init();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
});

onBeforeUnmount(() => {
  stopPlayheadFollow();
  painter.dispose();
});
</script>

<template>
  <div class="arrangement-view">
    <p v-if="error" class="arrangement-error" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="arrangement-notice" role="status">{{ notice }}</p>
    <div
      class="arrangement-grid"
      :style="{
        gridTemplateColumns: `${TRACK_HEADER_WIDTH_PX}px 1fr`,
        gridTemplateRows: `${SECTION_LANE_HEIGHT_PX}px ${CHORD_LANE_HEIGHT_PX}px 1fr`,
      }"
    >
      <div class="cell-corner">
        <span class="cell-corner-label">{{ t.shell.arrangement.sections }}</span>
        <SelectMenu
          v-model="snapChoice"
          class="arrangement-snap"
          size="sm"
          :options="SNAP_CHOICES"
          :aria-label="t.shell.editor.snap"
        />
        <span class="arrangement-zoom" role="group" :aria-label="t.shell.arrangement.verticalZoom">
          <button
            type="button"
            class="arrangement-zoom-button"
            v-tooltip="t.shell.arrangement.zoomOutTracks"
            :aria-label="t.shell.arrangement.zoomOutTracks"
            @click="zoomVertical(1 / VERTICAL_ZOOM_STEP)"
          >
            −
          </button>
          <button
            type="button"
            class="arrangement-zoom-button"
            v-tooltip="t.shell.arrangement.zoomInTracks"
            :aria-label="t.shell.arrangement.zoomInTracks"
            @click="zoomVertical(VERTICAL_ZOOM_STEP)"
          >
            +
          </button>
        </span>
        <button
          type="button"
          class="section-detect"
          :disabled="detectableAudioClip === null || isDetectingSections"
          v-tooltip="t.shell.arrangement.detectSectionsTitle"
          @click="detectSections"
        >
          {{ t.shell.arrangement.detectSections }}
        </button>
        <button
          type="button"
          class="section-detect"
          :disabled="!hasWrittenNotes"
          v-tooltip="t.shell.arrangement.sectionsFromNotesTitle"
          @click="sectionsFromNotes"
        >
          {{ t.shell.arrangement.sectionsFromNotes }}
        </button>
        <button
          type="button"
          class="section-detect"
          :disabled="detectableAudioClip === null || isExtractingMelody"
          v-tooltip="t.shell.arrangement.extractMelodyTitle"
          @click="extractMelody"
        >
          {{ t.shell.arrangement.extractMelody }}
        </button>
        <button
          type="button"
          class="section-detect"
          :disabled="detectableAudioClip === null || isSplittingStems"
          v-tooltip="t.shell.arrangement.splitStemsTitle"
          @click="splitToStems"
        >
          {{ t.shell.arrangement.splitStems }}
        </button>
        <button
          type="button"
          class="section-detect"
          :disabled="detectableAudioClip === null || midiTracks.length === 0 || isTuningToMidi"
          v-tooltip="t.shell.arrangement.tuneToMidiTitle"
          @click="openTuneToMidiMenu"
        >
          {{ t.shell.arrangement.tuneToMidi }}
        </button>
      </div>
      <SectionLane class="cell-sections" :range="range" :revision="revision" @seek="onSeek" />
      <div class="cell-corner">
        <span class="cell-corner-label">{{ t.shell.arrangement.chords }}</span>
        <button
          type="button"
          class="section-detect"
          v-tooltip="t.shell.arrangement.generateChordsTitle"
          @click="emit('generate')"
        >
          {{ t.shell.arrangement.generateChords }}
        </button>
      </div>
      <ChordLane
        class="cell-chords"
        :range="range"
        :revision="revision"
        :chords="store.chords"
        :time-signatures="store.timeSignatures"
        :key-map="arrangementKeyMap"
        :has-content="hasContent"
        show-hints
        @seek="onSeek"
        @open-chords="emit('openChords')"
      />
      <TrackHeaderList
        class="cell-headers"
        @wheel.prevent="onWheel"
        :lane-height="laneHeight"
        :scroll-y="scrollY"
        :ruler-offset="RULER_HEIGHT_PX"
        :armed-track-ids="props.armedTrackIds ?? []"
        :record-input-devices="props.recordInputDevices ?? []"
        :automation-expanded-ids="automationExpandedIds"
        :automation-params="automationParams"
        :takes-expanded-ids="takesExpandedIds"
        :tracks="visibleTracks"
        :collapsed-group-ids="collapsedGroupIds"
        :row-layout="rowLayout"
        :loop-enabled="props.loopEnabled ?? false"
        :loop-start-ppq="props.loopStartPpq ?? 0"
        :loop-end-ppq="props.loopEndPpq ?? 0"
        @arm="(trackId, armed) => emit('arm', trackId, armed)"
        @change-instrument="(trackId) => emit('changeInstrument', trackId)"
        @regenerate-track="(trackId, part) => emit('regenerateTrack', trackId, part)"
        @toggle-automation="onToggleAutomation"
        @automation-param="onAutomationParamChange"
        @toggle-takes="onToggleTakes"
        @toggle-group-collapse="onToggleGroupCollapse"
      />
      <div ref="canvasCell" class="cell-canvas" @wheel.prevent="onWheel">
        <ArrangementCanvas
          :range="range"
          :revision="revision"
          :painter="painter"
          :tracks="visibleTracks"
          :clips="visibleClips"
          :markers="store.markers"
          :active-track-id="store.activeTrackId"
          :active-clip-id="store.clipId"
          :selected-clip-ids="store.clipSelection"
          :time-signatures="store.timeSignatures"
          :scroll-y="scrollY"
          :lane-height="laneHeight"
          :loop-enabled="props.loopEnabled ?? false"
          :loop-start-ppq="props.loopStartPpq ?? 0"
          :loop-end-ppq="props.loopEndPpq ?? 0"
          :tempo-bpm="store.tempoBpm"
          :tempo-segments="store.tempoSegments"
          :grid-ppq="gridPpq"
          :snap-ppq="snapArrangementPpq"
          :interactions="interactions"
          :automation-expanded-ids="automationExpandedIds"
          :automation-params="automationParams"
          :automation-lanes="store.automationLanes"
          :automation="automation"
          :takes-expanded-ids="takesExpandedIds"
          :row-layout="rowLayout"
          :takes="takes"
          :take-silence="takeSilence.byClip.value"
          :position-ppq="props.positionPpq"
          :anchored-local-x="followAnchorLocalX"
          @view-resize="onCanvasResize"
          @ruler-seek="onSeek"
          @loop-range="(startPpq, endPpq) => emit('loopRange', startPpq, endPpq)"
          @clip-context="onClipContext"
          @clip-keyboard-action="onClipKeyboardAction"
          @ruler-context="onRulerContext"
        />
      </div>
    </div>
    <ArrangementAnalysisPanel :is-playing="props.isPlaying" @jump="onSeek" />
  </div>
</template>

<style scoped>
.arrangement-view {
  display: flex;
  flex-direction: column;
  width: 100%;
  /* Fill the remaining height of the arrange zone, sharing it with a sibling
     clip-inspector bar in the shell. */
  flex: 1 1 auto;
  min-height: 0;
  background: var(--surface-0);
  color: var(--text-2);
}

.arrangement-error {
  margin: 0;
  padding: 0.5rem 0.75rem;
  background: var(--danger-surface);
  color: var(--danger-text);
  font: var(--fs-sm)/1.4 var(--font-sans);
}

.arrangement-notice {
  margin: 0;
  padding: 0.5rem 0.75rem;
  background: var(--surface-2);
  color: var(--text-2);
  font: var(--fs-sm)/1.4 var(--font-sans);
}

.arrangement-grid {
  flex: 1;
  min-height: 0;
  display: grid;
}

.cell-corner {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-4);
  font: var(--fw-semibold) var(--fs-chrome-lg) var(--font-sans);
  letter-spacing: 0.08em;
  color: var(--text-4);
  background: var(--surface-2);
  border-right: 1px solid var(--border-strong);
  border-bottom: 1px solid var(--border-strong);
  box-shadow: var(--raise-hi);
}

.cell-corner-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.arrangement-snap {
  flex: none;
}

.arrangement-zoom {
  display: flex;
  flex: none;
  gap: 2px;
}

.arrangement-zoom-button {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 1.35rem;
  padding: 1px 3px;
  color: var(--text-3);
  font: var(--fw-semibold) var(--fs-xs) var(--font-sans);
  background: var(--surface-3);
  border-radius: var(--radius-sm);
}

.arrangement-zoom-button:hover {
  color: var(--text-1);
}

.section-detect {
  flex: none;
  padding: 1px var(--sp-2);
  font: var(--fw-semibold) var(--fs-chrome-lg) var(--font-sans);
  letter-spacing: 0.04em;
  color: var(--text-2);
  background: var(--surface-3);
  border-radius: var(--radius-sm);
  box-shadow: var(--control-lift);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease-out), box-shadow var(--dur-1) var(--ease-out);
}

.section-detect:hover:not(:disabled) {
  color: var(--text-1);
  background: var(--surface-4);
  box-shadow: var(--control-lift-hover);
}

.section-detect:focus-visible {
  box-shadow: var(--control-lift), var(--ring);
}

.section-detect:disabled {
  opacity: 0.4;
  cursor: default;
}

.cell-sections {
  min-width: 0;
}

.cell-chords {
  min-width: 0;
}

.cell-headers {
  min-height: 0;
}

.cell-canvas {
  position: relative;
  min-width: 0;
  min-height: 0;
}
</style>
