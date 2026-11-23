<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { useEditorTool } from '@/composables/useEditorTool';
import { buildKeyMap } from '@/compose/key-map';
import { describeError } from '@/lib/errors';
import { ensureWasm } from '@/lib/wasm';
import { loadAsset } from '@/persistence/assets';
import { clipSplitBlockReason, resolveClipSplitTarget } from '@/project/clip-split';
import {
  addMidiClip,
  clearActiveClipSelection,
  deleteClip,
  duplicateClip,
  moveClip,
  moveClips,
  setActiveClip,
  setAutomationLanePoints,
  setClipActiveTake,
  setClipCompSegments,
  setClipFades,
  setClipMidiActiveTake,
  setClipMidiCompSegments,
  setClipSelection,
  splitClip,
  type TrackPart,
  trimClip,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { normalizeTempoMap } from '@/project/tempo-map';
import { snapPpqToMeterGrid } from '@/project/time-signature';
import { canTrackContainClip, clipKind, isAudioClip } from '@/project/types';
import { assetLengthPpq, audioClipSourceBounds } from '@/ui/arrangement/audio-clip-content';
import { getLoadedAudioAsset } from '@/ui/arrangement/audio-clip-data';
import { AUTOMATION_LANE_HEIGHT_PX, automationLaneDomain } from '@/ui/arrangement/automation-rows';
import { barRangeAt } from '@/ui/arrangement/ruler';
import { useArrangementClipMenu } from '@/ui/arrangement/use-arrangement-clip-menu';
import { useArrangementProcessing } from '@/ui/arrangement/use-arrangement-processing';
import { useArrangementRows } from '@/ui/arrangement/use-arrangement-rows';
import { useArrangementRulerMenu } from '@/ui/arrangement/use-arrangement-ruler-menu';
import { useAutomationInteractions } from '@/ui/arrangement/use-automation-interactions';
import {
  type ClipInteractionsView,
  useClipInteractions,
} from '@/ui/arrangement/use-clip-interactions';
import { useClipKeyboardActions } from '@/ui/arrangement/use-clip-keyboard-actions';
import { useCommonTakeSilence } from '@/ui/arrangement/use-common-take-silence';
import { usePlayheadFollow } from '@/ui/arrangement/use-playhead-follow';
import { useTakeInteractions } from '@/ui/arrangement/use-take-interactions';
import { createPainter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';
import { useI18n } from '@/ui/i18n';
import { snapChoices } from '@/ui/shell/app-shell-options';
import { useSnapChoice } from '@/ui/shell/use-snap-choice';
import ArrangementAnalysisPanel from './ArrangementAnalysisPanel.vue';
import ArrangementCanvas from './ArrangementCanvas.vue';
import ChordLane from './ChordLane.vue';
import SectionLane from './SectionLane.vue';
import TrackHeaderList from './TrackHeaderList.vue';
import TranscribeDialog from './TranscribeDialog.vue';
import {
  CHORD_LANE_HEIGHT_PX,
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
  /** Request to vary the drums in a named section. */
  regenerateSectionDrums: [sectionId: number];
  /** Request to open the music-generation dialog (chord-lane corner button). */
  generate: [];
  /** Request to reveal the chord list editor (chord-lane double-click). */
  openChords: [];
}>();

const appSettings = useAppSettings();
const store = useProjectStore();
const { t } = useI18n();
const snapChoice = useSnapChoice();
/** The project's key timeline, read by the chord lane's harmonic analysis. */
const arrangementKeyMap = computed(() => buildKeyMap(store.scaleHighlight, store.markers));

/** Initialization/runtime error surfaced above the view. */
const error = ref('');

/** Result line of the last tuning, shown until the next action. */
const notice = ref('');

/** Whether any track carries audible content (notes or audio) yet. */
const hasContent = computed(() =>
  store.clips.some((clip) => clip.notes.length > 0 || isAudioClip(clip)),
);

const {
  detectSectionsBlocked,
  sectionsFromNotesBlocked,
  transcribeBlocked,
  splitStemsBlocked,
  tuneToMidiBlocked,
  componentSplitAbort,
  transcribeDialogClipId,
  detectSections,
  sectionsFromNotes,
  openTranscribeDialog,
  closeTranscribeDialog,
  onSplitStemsClick,
  openTuneToMidiMenu,
} = useArrangementProcessing({ error, notice, isTrackFrozen });

function isTrackFrozen(trackId: number | undefined): boolean {
  return store.tracks.find((track) => track.id === trackId)?.frozen !== undefined;
}

/** Default horizontal zoom in px per quarter note (one 4/4 bar = 40 px). */
const DEFAULT_PX_PER_PPQ = 10;
/** Wheel-to-zoom sensitivity for ⌘wheel / pinch gestures. */
const ZOOM_WHEEL_SENSITIVITY = 0.0035;
/** Per-click multiplier for the arrangement's vertical track zoom. */
const VERTICAL_ZOOM_STEP = 1.2;

// The TimelineRange and painter are plain (non-reactive) objects; views are
// invalidated through the `revision` counter after every range mutation.
const range = markRaw(new TimelineRange({ widthPx: 1, heightPx: 1, pxPerPpq: DEFAULT_PX_PER_PPQ }));
const painter = markRaw(createPainter());

/** Bumped after any TimelineRange or scroll mutation to trigger redraws. */
const revision = ref(0);

function bump(): void {
  revision.value++;
}

const {
  scrollY,
  laneHeight,
  automationExpandedIds,
  automationParams,
  takesExpandedIds,
  collapsedGroupIds,
  visibleTracks,
  visibleTrackIds,
  visibleClips,
  rowLayout,
  clampScrollY,
  onRevealTrack,
  onToggleGroupCollapse,
  onToggleAutomation,
  onAutomationParamChange,
  onToggleTakes,
  zoomVertical,
  onCanvasResize,
} = useArrangementRows({ range, bump });

/** Snap grid step in PPQ derived from the store (0 when snapping is off). */
const gridPpq = computed(() => (store.snapEnabled ? 4 / store.snapDivision : 0));
const snapArrangementPpq = (ppq: number): number =>
  snapPpqToMeterGrid(store.timeSignatures, ppq, store.snapBar ? 'bar' : gridPpq.value);

/** Moves an arrangement position to the adjacent meter-defined bar boundary. */
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

/** Resolves the content track under a viewport y coordinate on the canvas, excluding sublanes. */
function trackIdAtClientY(clientY: number): number | null {
  const y = clientY - (canvasCell.value?.getBoundingClientRect().top ?? 0);
  if (y < RULER_HEIGHT_PX) return null;
  const hit = rowLayout.value.hitTest(y - RULER_HEIGHT_PX + scrollY.value);
  if (hit?.zone !== 'track') return null;
  return visibleTracks.value[hit.index]?.id ?? null;
}

/** Normalized project tempo map, rebuilt only when the tempo state changes. */
const tempoMap = computed(() => normalizeTempoMap(store.tempoSegments, store.tempoBpm));

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
    tempoMap.value,
    clip.startPpq - clip.sourceOffsetPpq,
  );
  return audioClipSourceBounds(clip, assetPpq);
}

const { tool } = useEditorTool();

const interactions = useClipInteractions({
  view: laneView,
  getClips: () => visibleClips.value,
  getTrackIds: () => visibleTrackIds.value,
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
  onCommandError: (cause) => {
    error.value = describeError(cause, t.value.notices.errors);
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
  tempo: () => tempoMap.value,
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

/** Fits the full arranged clip range into the timeline viewport. */
function zoomToFit(): void {
  const endPpq = Math.max(4, ...store.clips.map((clip) => clip.startPpq + clip.lengthPpq));
  range.zoomAt(0, range.widthPx / endPpq / range.pxPerPpq);
  range.setStartPpq(0);
  bump();
}

const { followAnchorLocalX } = usePlayheadFollow({
  range,
  bump,
  isPlaying: () => props.isPlaying === true,
  followEnabled: () => appSettings.settings.scrollFollowPlayhead,
  positionPpq: () => props.positionPpq?.(),
  leadingColumnWidthPx: TRACK_HEADER_WIDTH_PX,
});

function onSeek(ppq: number): void {
  emit('seek', ppq);
}

const { onClipKeyboardAction } = useClipKeyboardActions({
  error,
  gridPpq,
  visibleTracks,
  sourceBoundsFor,
});

const { onClipContext } = useArrangementClipMenu({
  error,
  notice,
  isTrackFrozen,
  gridPpq,
  snapPpq: snapArrangementPpq,
  sourceBoundsFor,
  trackIdAtClientY,
});
const { onRulerContext } = useArrangementRulerMenu({ error });

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
  const target = resolveClipSplitTarget(store.clips, store.activeClip, store.activeTrackId, ppq);
  if (!target) return;
  if (clipSplitBlockReason(target, ppq) === 'loop') {
    error.value = t.value.shell.arrangement.loopSplitUnavailable;
    return;
  }
  try {
    splitClip(target.id, ppq);
    error.value = '';
  } catch (err) {
    error.value = describeError(err, t.value.notices.errors);
  }
}

defineExpose({ cutAtPlayhead, zoomHorizontal, zoomToFit });

onMounted(async () => {
  try {
    await store.init();
  } catch (err) {
    error.value = describeError(err, t.value.notices.errors);
  }
});

onBeforeUnmount(() => {
  painter.dispose();
});
</script>

<template>
  <div class="arrangement-view">
    <p v-if="error" class="arrangement-error" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="arrangement-notice" role="status">{{ notice }}</p>
    <div class="arrangement-command-bar">
      <div class="arrangement-view-controls">
        <SelectMenu
          v-model="snapChoice"
          class="arrangement-snap"
          size="sm"
          :options="snapChoices(t.shell.editor.snapBar)"
          :aria-label="t.shell.editor.snap"
          :title="t.shell.arrangement.snapTitle"
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
      </div>
      <div class="arrangement-process-group" role="group" :aria-label="t.shell.arrangement.sectionsGroup">
        <span class="arrangement-group-label" aria-hidden="true">{{
          t.shell.arrangement.sectionsGroup
        }}</span>
        <button
          type="button"
          class="section-detect"
          :disabled="!!detectSectionsBlocked"
          v-tooltip="{
            text: t.shell.arrangement.detectSectionsTitle,
            reason: detectSectionsBlocked,
          }"
          @click="detectSections"
        >
          {{ t.shell.arrangement.detectSections }}
        </button>
        <button
          type="button"
          class="section-detect"
          :disabled="!!sectionsFromNotesBlocked"
          v-tooltip="{
            text: t.shell.arrangement.sectionsFromNotesTitle,
            reason: sectionsFromNotesBlocked,
          }"
          @click="sectionsFromNotes"
        >
          {{ t.shell.arrangement.sectionsFromNotes }}
        </button>
      </div>
      <div class="arrangement-process-group" role="group" :aria-label="t.shell.arrangement.audioGroup">
        <span class="arrangement-group-label" aria-hidden="true">{{
          t.shell.arrangement.audioGroup
        }}</span>
        <button
          type="button"
          class="section-detect"
          :disabled="!!transcribeBlocked"
          v-tooltip="{ text: t.shell.arrangement.extractMelodyTitle, reason: transcribeBlocked }"
          @click="openTranscribeDialog"
        >
          {{ t.shell.arrangement.extractMelody }}
        </button>
        <button
          type="button"
          class="section-detect"
          :class="{ 'is-running': componentSplitAbort !== null }"
          :disabled="!!splitStemsBlocked"
          v-tooltip="{
            text: componentSplitAbort
              ? t.shell.arrangement.cancelSplitTitle
              : t.shell.arrangement.splitStemsTitle,
            reason: splitStemsBlocked,
          }"
          @click="onSplitStemsClick"
        >
          {{ componentSplitAbort ? t.shell.arrangement.cancelSplit : t.shell.arrangement.splitStems }}
        </button>
        <button
          type="button"
          class="section-detect"
          :disabled="!!tuneToMidiBlocked"
          v-tooltip="{ text: t.shell.arrangement.tuneToMidiTitle, reason: tuneToMidiBlocked }"
          @click="openTuneToMidiMenu"
        >
          {{ t.shell.arrangement.tuneToMidi }}
        </button>
      </div>
    </div>
    <div
      class="arrangement-grid"
      :style="{
        gridTemplateColumns: `${TRACK_HEADER_WIDTH_PX}px 1fr`,
        gridTemplateRows: `${SECTION_LANE_HEIGHT_PX}px ${CHORD_LANE_HEIGHT_PX}px 1fr`,
      }"
    >
      <div class="cell-corner">
        <span class="cell-corner-label">{{ t.shell.arrangement.sections }}</span>
      </div>
      <SectionLane
        class="cell-sections"
        :range="range"
        :revision="revision"
        @seek="onSeek"
        @regenerate-drums="(sectionId) => emit('regenerateSectionDrums', sectionId)"
      />
      <div class="cell-corner">
        <span class="cell-corner-label">{{ t.shell.arrangement.chords }}</span>
        <button
          type="button"
          class="section-detect"
          :class="{ 'is-suggested': store.chords.length === 0 }"
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
        @generate="emit('generate')"
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
        @reveal-track="onRevealTrack"
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
    <TranscribeDialog
      :open="transcribeDialogClipId !== null"
      :clip-id="transcribeDialogClipId"
      @close="closeTranscribeDialog"
    />
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

.arrangement-error,
.arrangement-notice {
  animation: fade-once var(--dur-2) var(--ease-out);
}

.arrangement-grid {
  flex: 1;
  min-height: 0;
  display: grid;
}

.arrangement-command-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-5);
  box-sizing: border-box;
  flex: none;
  min-width: 0;
  min-height: 34px;
  padding: 3px var(--sp-4);
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border-strong);
}

.arrangement-view-controls,
.arrangement-process-group {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: none;
}

.arrangement-process-group {
  padding-left: var(--sp-5);
  border-left: 1px solid var(--border);
}

.arrangement-group-label {
  margin-right: var(--sp-1);
  font: var(--fw-semibold) var(--fs-chrome-lg) var(--font-sans);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-4);
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
  flex: 0 0 110px;
}

.arrangement-zoom {
  display: flex;
  flex: none;
  gap: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.arrangement-zoom-button {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  min-height: 22px;
  padding: 1px 4px;
  color: var(--text-2);
  font: var(--fw-semibold) var(--fs-md) var(--font-sans);
  background: var(--surface-2);
  border-radius: 0;
  box-shadow: none;
}

.arrangement-zoom-button + .arrangement-zoom-button {
  border-left: 1px solid var(--border);
}

.arrangement-zoom-button:hover {
  color: var(--text-1);
}

.section-detect {
  flex: none;
  min-height: 24px;
  padding: 3px var(--sp-4);
  font: var(--fw-medium) var(--fs-2xs) var(--font-sans);
  letter-spacing: 0.01em;
  color: var(--text-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  box-shadow: none;
  cursor: pointer;
  transition: background var(--dur-1) var(--ease-out), box-shadow var(--dur-1) var(--ease-out);
}

.section-detect:hover:not(:disabled) {
  color: var(--text-1);
  background: var(--surface-3);
}

.section-detect:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

.section-detect.is-running {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 28%, transparent);
}

.section-detect.is-suggested {
  color: var(--accent);
}

.section-detect:disabled {
  color: var(--text-4);
  opacity: 0.7;
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
