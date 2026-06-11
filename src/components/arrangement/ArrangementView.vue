<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  addMidiClip,
  duplicateClip,
  moveClip,
  setActiveClip,
  splitClip,
  trimClip,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { barRangeAt } from '@/ui/arrangement/ruler';
import {
  type ClipInteractionsView,
  useClipInteractions,
} from '@/ui/arrangement/use-clip-interactions';
import { createPainter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';
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
 */

const props = defineProps<{
  /** Playhead position getter in PPQ; omit to hide the playhead. */
  positionPpq?: () => number;
  /** Whether the transport loop is enabled (shown on the ruler). */
  loopEnabled?: boolean;
  /** Transport loop start in PPQ. */
  loopStartPpq?: number;
  /** Transport loop end in PPQ. */
  loopEndPpq?: number;
}>();

const emit = defineEmits<{
  /** Request to move the transport playhead to an absolute PPQ position. */
  seek: [ppq: number];
}>();

const store = useProjectStore();

/** Initialization/runtime error surfaced above the view. */
const error = ref('');

/** Default horizontal zoom in px per quarter note (one 4/4 bar = 40 px). */
const DEFAULT_PX_PER_PPQ = 10;
/** Wheel-to-zoom sensitivity for ⌘wheel / pinch gestures. */
const ZOOM_WHEEL_SENSITIVITY = 0.0035;

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

/** Clamps the lane scroll offset to the track content extent. */
function clampScrollY(y: number): number {
  const viewport = Math.max(0, range.heightPx - RULER_HEIGHT_PX);
  const content = store.tracks.length * LANE_HEIGHT_PX;
  return Math.min(Math.max(0, content - viewport), Math.max(0, y));
}

/** Snap grid step in PPQ derived from the store (0 when snapping is off). */
const gridPpq = computed(() => (store.snapEnabled ? 4 / store.snapDivision : 0));

// Lane view contract for the clip gestures: horizontal mapping from the
// shared range, vertical mapping from the lane layout and scroll offset.
const laneView: ClipInteractionsView = {
  ppqToX: (ppq) => range.ppqToX(ppq),
  xToPpq: (x) => range.xToPpq(x),
  laneTop: (index) => RULER_HEIGHT_PX + index * LANE_HEIGHT_PX - scrollY.value,
  laneIndexAtY: (y) => Math.floor((y - RULER_HEIGHT_PX + scrollY.value) / LANE_HEIGHT_PX),
  get laneHeight() {
    return LANE_HEIGHT_PX;
  },
  get laneCount() {
    return store.tracks.length;
  },
};

const interactions = useClipInteractions({
  view: laneView,
  getClips: () => store.clips,
  getTrackIds: () => store.tracks.map((track) => track.id),
  getGridPpq: () => gridPpq.value,
  getBarRange: (ppq) => barRangeAt(store.timeSignatures, ppq),
  commands: {
    selectClip: (clipId) => setActiveClip(clipId),
    moveClip,
    trimClip,
    duplicateClip,
    createClip: (trackId, startPpq, lengthPpq) => addMidiClip({ trackId, startPpq, lengthPpq }),
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

function onSeek(ppq: number): void {
  emit('seek', ppq);
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

// Track removal can shrink the content extent below the current scroll.
watch(
  () => store.tracks.length,
  () => {
    scrollY.value = clampScrollY(scrollY.value);
    bump();
  },
);

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
  <div class="arrangement-view">
    <p v-if="error" class="arrangement-error" role="alert">{{ error }}</p>
    <div
      class="arrangement-grid"
      :style="{
        gridTemplateColumns: `${TRACK_HEADER_WIDTH_PX}px 1fr`,
        gridTemplateRows: `${SECTION_LANE_HEIGHT_PX}px 1fr`,
      }"
    >
      <div class="cell-corner">SECTIONS</div>
      <SectionLane class="cell-sections" :range="range" :revision="revision" @seek="onSeek" />
      <TrackHeaderList
        class="cell-headers"
        :lane-height="LANE_HEIGHT_PX"
        :scroll-y="scrollY"
        :ruler-offset="RULER_HEIGHT_PX"
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
          :interactions="interactions"
          :position-ppq="props.positionPpq"
          @view-resize="onCanvasResize"
          @ruler-seek="onSeek"
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
  height: 100%;
  min-height: 160px;
  background: #0b0d11;
  color: #c8cdd6;
}

.arrangement-error {
  margin: 0;
  padding: 0.5rem 0.75rem;
  background: #3b1219;
  color: #ffb4b4;
  font: 12px/1.4 system-ui, sans-serif;
}

.arrangement-grid {
  flex: 1;
  min-height: 0;
  display: grid;
}

.cell-corner {
  display: flex;
  align-items: center;
  padding: 0 8px;
  font: 600 9px system-ui, sans-serif;
  letter-spacing: 0.08em;
  color: #5b6270;
  background: #14161b;
  border-right: 1px solid rgba(0, 0, 0, 0.5);
  border-bottom: 1px solid rgba(0, 0, 0, 0.5);
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
