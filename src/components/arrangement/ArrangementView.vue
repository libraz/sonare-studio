<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { promptDialog } from '@/composables/useDialogs';
import { useEditorTool } from '@/composables/useEditorTool';
import { useFileDownloads } from '@/composables/useFileDownloads';
import type { AutomationParam } from '@/project/automation';
import {
  addMidiClip,
  consolidateAudioClips,
  deleteClip,
  detectSectionsFromAudioClip,
  duplicateClip,
  extractMelodyFromAudioClip,
  glueMidiClips,
  moveClip,
  renameClip,
  setActiveClip,
  setAutomationLanePoints,
  setClipActiveTake,
  setClipCompSegments,
  setClipFades,
  setClipLoop,
  setMarker,
  splitAudioClipToStems,
  splitClip,
  trimClip,
} from '@/project/commands';
import { exportClipSmf } from '@/project/export';
import { insertParamDomainForStrip } from '@/project/insert-param-domains';
import { useProjectStore } from '@/project/store';
import { isAudioClip } from '@/project/types';
import { assetLengthPpq, audioClipSourceBounds } from '@/ui/arrangement/audio-clip-content';
import { getLoadedAudioAsset } from '@/ui/arrangement/audio-clip-data';
import {
  AUTOMATION_LANE_HEIGHT_PX,
  buildRowLayout,
  trackTakeRowCount,
} from '@/ui/arrangement/automation-rows';
import { nextPlayheadFollowStart } from '@/ui/arrangement/playhead-follow';
import { barRangeAt } from '@/ui/arrangement/ruler';
import { useAutomationInteractions } from '@/ui/arrangement/use-automation-interactions';
import {
  type ClipInteractionsView,
  snapToStep,
  useClipInteractions,
} from '@/ui/arrangement/use-clip-interactions';
import { useTakeInteractions } from '@/ui/arrangement/use-take-interactions';
import { createPainter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';
import { useI18n } from '@/ui/i18n';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';
import ArrangementCanvas from './ArrangementCanvas.vue';
import SectionLane from './SectionLane.vue';
import TrackHeaderList from './TrackHeaderList.vue';
import {
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
  /** Request to (dis)arm a track for recording (re-emitted from the headers). */
  arm: [trackId: number, armed: boolean];
  /** Request to open a MIDI track's instrument picker. */
  changeInstrument: [trackId: number];
}>();

const appSettings = useAppSettings();
const store = useProjectStore();
const { t } = useI18n();
const { downloadBlobFile } = useFileDownloads();

/** Initialization/runtime error surfaced above the view. */
const error = ref('');

/** True while a section detection is awaiting the engine. */
const isDetectingSections = ref(false);

/** True while a melody extraction is awaiting the engine. */
const isExtractingMelody = ref(false);

/** True while a stem separation is awaiting the engine. */
const isSplittingStems = ref(false);

/** The active clip when it is an audio clip carrying an asset, else null. */
const detectableAudioClip = computed(() => {
  const clip = store.activeClip;
  return clip && isAudioClip(clip) && clip.assetId !== undefined ? clip : null;
});

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

/** Default horizontal zoom in px per quarter note (one 4/4 bar = 40 px). */
const DEFAULT_PX_PER_PPQ = 10;
/** Wheel-to-zoom sensitivity for ⌘wheel / pinch gestures. */
const ZOOM_WHEEL_SENSITIVITY = 0.0035;

/** Per-frame horizontal follow interpolation for arrangement playback. */
const PLAYHEAD_FOLLOW_SMOOTHING = 0.42;
/** Small PPQ threshold below which snapping avoids endless tiny repaints. */
const PLAYHEAD_FOLLOW_EPSILON_PPQ = 0.0005;
/** Follow scrolling redraws the full arrangement base layer, so cap it below display refresh. */
const PLAYHEAD_FOLLOW_INTERVAL_MS = 33;
/** Ignore sub-pixel follow movement; the overlay playhead still updates every frame. */
const PLAYHEAD_FOLLOW_MIN_PX = 1;

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

// --- Automation sublane state ----------------------------------------------

/** Ids of tracks whose automation sublane is expanded (view-local state). */
const automationExpandedIds = ref<number[]>([]);

/** Selected automation parameter per track id (absent = 'faderDb'). */
const automationParams = ref<Record<number, AutomationParam>>({});

/** Ids of tracks whose take sub-rows are expanded (view-local state). */
const takesExpandedIds = ref<number[]>([]);

/** Row layout reflecting which tracks show take sub-rows or an automation sublane. */
const rowLayout = computed(() => {
  const expanded = new Set(automationExpandedIds.value);
  const takesExpanded = new Set(takesExpandedIds.value);
  return buildRowLayout(
    store.tracks.map((track) => expanded.has(track.id)),
    LANE_HEIGHT_PX,
    AUTOMATION_LANE_HEIGHT_PX,
    store.tracks.map((track) =>
      takesExpanded.has(track.id) ? trackTakeRowCount(store.clips, track.id) : 0,
    ),
  );
});

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
    if (contentY < 0) return Math.floor(contentY / LANE_HEIGHT_PX);
    const hit = rowLayout.value.hitTest(contentY);
    return hit ? hit.index : store.tracks.length;
  },
  get laneHeight() {
    return LANE_HEIGHT_PX;
  },
  get laneCount() {
    return store.tracks.length;
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
  const assetPpq = assetLengthPpq(asset.meta.numFrames, asset.meta.sampleRate, store.tempoBpm);
  return audioClipSourceBounds(clip, assetPpq);
}

const { tool } = useEditorTool();

const interactions = useClipInteractions({
  view: laneView,
  getClips: () => store.clips,
  getTrackIds: () => store.tracks.map((track) => track.id),
  getGridPpq: () => gridPpq.value,
  getBarRange: (ppq) => barRangeAt(store.timeSignatures, ppq),
  getSourceBounds: sourceBoundsFor,
  getTool: () => tool.value,
  commands: {
    selectClip: (clipId) => setActiveClip(clipId),
    moveClip,
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
      const track = store.tracks[hit.index];
      const param = automationParams.value[track.id] ?? 'faderDb';
      const insertDomain = insertParamDomainForStrip(track.mixer, param);
      return {
        trackId: track.id,
        param,
        top: RULER_HEIGHT_PX + rowLayout.value.automationTop(hit.index) - scrollY.value,
        height: AUTOMATION_LANE_HEIGHT_PX,
        ...(insertDomain ? { insertDomain: { min: insertDomain.min, max: insertDomain.max } } : {}),
      };
    },
  },
  getLanePoints: (trackId, param) =>
    store.automationLanes.find((lane) => lane.target === trackId && lane.param === param)?.points ??
    [],
  getGridPpq: () => gridPpq.value,
  commands: {
    setPoints: (trackId, param, points) => setAutomationLanePoints(trackId, param, points),
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
      return { trackId: store.tracks[hit.index].id, takeIndex: hit.takeIndex };
    },
  },
  getClips: () => store.clips,
  commands: {
    setActiveTake: setClipActiveTake,
    setCompSegments: setClipCompSegments,
  },
});

const canvasCell = ref<HTMLDivElement | null>(null);

function onWheel(event: WheelEvent): void {
  const anchorEl = canvasCell.value;
  if (!anchorEl) return;
  if (event.metaKey || event.ctrlKey) {
    const anchorX = event.clientX - anchorEl.getBoundingClientRect().left;
    range.zoomAt(anchorX, Math.exp(-event.deltaY * ZOOM_WHEEL_SENSITIVITY));
  } else if (event.shiftKey) {
    range.scrollByPx(event.deltaY + event.deltaX);
  } else {
    range.scrollByPx(event.deltaX);
    scrollY.value = clampScrollY(scrollY.value + event.deltaY);
  }
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

function onSeek(ppq: number): void {
  emit('seek', ppq);
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

async function consolidateAudioCluster(clipIds: number[]): Promise<void> {
  const id = await consolidateAudioClips(clipIds);
  setActiveClip(id);
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
  const splitPpq = snapToStep(payload.ppq, gridPpq.value);
  const canSplit = splitPpq > clip.startPpq && splitPpq < end;
  const glueIds = glueClusterClipIds(clip.id);
  const consolidateIds = audioConsolidateClipIds(clip.id);
  const items: ContextMenuItem[] = [
    {
      id: 'split',
      label: 'Split here',
      hint: '3',
      disabled: !canSplit,
      run: () => setActiveClip(splitClip(clip.id, splitPpq)),
    },
    { id: 'duplicate', label: 'Duplicate', run: () => setActiveClip(duplicateClip(clip.id, end)) },
    {
      id: 'glue',
      label: 'Glue joined clips',
      disabled: glueIds.length < 2,
      run: () => setActiveClip(glueMidiClips(glueIds)),
    },
    {
      id: 'consolidate-audio',
      label: 'Consolidate audio clips',
      disabled: consolidateIds.length < 2,
      run: () => void consolidateAudioCluster(consolidateIds),
    },
    { id: 'rename', label: 'Rename…', run: () => renameClipFromPrompt(clip.id, clip.name) },
    {
      id: 'loop',
      label: clip.loopEnabled ? 'Disable loop' : 'Enable loop',
      run: () => setClipLoop(clip.id, !clip.loopEnabled),
    },
  ];
  if (!isAudioClip(clip)) {
    items.push({ id: 'export-midi', label: 'Export MIDI…', run: () => exportClipToSmf(clip.id) });
  }
  items.push(
    { id: 'sep-1', separator: true },
    { id: 'delete', label: 'Delete', danger: true, run: () => deleteClip(clip.id) },
  );
  openContextMenu(payload.x, payload.y, items);
}

/** Builds and opens the right-click menu for the bar/beat ruler. */
function onRulerContext(payload: { x: number; y: number; ppq: number }): void {
  const items: ContextMenuItem[] = [
    {
      id: 'marker',
      label: 'Add marker here…',
      run: () => addMarkerFromPrompt(payload.ppq),
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
function renameClipFromPrompt(clipId: number, current: string): void {
  void (async () => {
    const next = await promptDialog({
      title: 'Rename clip',
      message: 'Enter a name for this clip.',
      defaultValue: current,
      placeholder: 'Clip name',
      confirmLabel: 'Rename',
    });
    if (next && next !== current) renameClip(clipId, next);
  })();
}

/** Adds a marker at a position via a prompt for its name. */
function addMarkerFromPrompt(ppq: number): void {
  void (async () => {
    const name = await promptDialog({
      title: 'Add marker',
      message: 'Name the marker placed at this position.',
      defaultValue: 'Marker',
      placeholder: 'Marker name',
      confirmLabel: 'Add',
    });
    if (name) setMarker(null, ppq, name);
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
  try {
    splitClip(target.id, ppq);
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

defineExpose({ cutAtPlayhead });

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
    <div
      class="arrangement-grid"
      :style="{
        gridTemplateColumns: `${TRACK_HEADER_WIDTH_PX}px 1fr`,
        gridTemplateRows: `${SECTION_LANE_HEIGHT_PX}px 1fr`,
      }"
    >
      <div class="cell-corner">
        <span class="cell-corner-label">{{ t.shell.arrangement.sections }}</span>
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
      </div>
      <SectionLane class="cell-sections" :range="range" :revision="revision" @seek="onSeek" />
      <TrackHeaderList
        class="cell-headers"
        :lane-height="LANE_HEIGHT_PX"
        :scroll-y="scrollY"
        :ruler-offset="RULER_HEIGHT_PX"
        :armed-track-ids="props.armedTrackIds ?? []"
        :record-input-devices="props.recordInputDevices ?? []"
        :automation-expanded-ids="automationExpandedIds"
        :automation-params="automationParams"
        :takes-expanded-ids="takesExpandedIds"
        :loop-enabled="props.loopEnabled ?? false"
        :loop-start-ppq="props.loopStartPpq ?? 0"
        :loop-end-ppq="props.loopEndPpq ?? 0"
        @arm="(trackId, armed) => emit('arm', trackId, armed)"
        @change-instrument="(trackId) => emit('changeInstrument', trackId)"
        @toggle-automation="onToggleAutomation"
        @automation-param="onAutomationParamChange"
        @toggle-takes="onToggleTakes"
      />
      <div ref="canvasCell" class="cell-canvas" @wheel.prevent="onWheel">
        <ArrangementCanvas
          :range="range"
          :revision="revision"
          :painter="painter"
          :tracks="store.tracks"
          :clips="store.clips"
          :markers="store.markers"
          :active-track-id="store.activeTrackId"
          :active-clip-id="store.clipId"
          :time-signatures="store.timeSignatures"
          :scroll-y="scrollY"
          :lane-height="LANE_HEIGHT_PX"
          :loop-enabled="props.loopEnabled ?? false"
          :loop-start-ppq="props.loopStartPpq ?? 0"
          :loop-end-ppq="props.loopEndPpq ?? 0"
          :tempo-bpm="store.tempoBpm"
          :interactions="interactions"
          :automation-expanded-ids="automationExpandedIds"
          :automation-params="automationParams"
          :automation-lanes="store.automationLanes"
          :automation="automation"
          :takes-expanded-ids="takesExpandedIds"
          :takes="takes"
          :position-ppq="props.positionPpq"
          @view-resize="onCanvasResize"
          @ruler-seek="onSeek"
          @clip-context="onClipContext"
          @ruler-context="onRulerContext"
        />
      </div>
    </div>
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
  font: var(--fw-semibold) 9px var(--font-sans);
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

.section-detect {
  flex: none;
  padding: 1px var(--sp-2);
  font: var(--fw-semibold) 9px var(--font-sans);
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

.cell-headers {
  min-height: 0;
}

.cell-canvas {
  position: relative;
  min-width: 0;
  min-height: 0;
}
</style>
