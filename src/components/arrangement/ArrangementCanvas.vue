<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getCanvasContext, setupCanvas } from '@/components/piano-roll/theme';
import type { AutomationLaneState, AutomationParam } from '@/project/automation';
import type { EditorClip, EditorMarker, EditorTrack, TimeSignatureSegment } from '@/project/types';
import {
  AUTOMATION_LANE_HEIGHT_PX,
  buildRowLayout,
  trackTakeRowCount,
} from '@/ui/arrangement/automation-rows';
import { barLengthPpq, createRulerTickCache } from '@/ui/arrangement/ruler';
import type { AutomationInteractions } from '@/ui/arrangement/use-automation-interactions';
import { drawAutomationLanes } from '@/ui/arrangement/use-automation-sublane';
import type { ClipInteractions } from '@/ui/arrangement/use-clip-interactions';
import { type ClipRenderContext, drawClips } from '@/ui/arrangement/use-clip-rendering';
import { usePlayheadOverlay } from '@/ui/arrangement/use-playhead-overlay';
import { usePointerRouting } from '@/ui/arrangement/use-pointer-routing';
import { drawGrid, drawLanes, drawRuler } from '@/ui/arrangement/use-ruler-rendering';
import type { TakeInteractions } from '@/ui/arrangement/use-take-interactions';
import { drawTakeLanes } from '@/ui/arrangement/use-take-lanes';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { useI18n } from '@/ui/i18n';
import { ARRANGEMENT_COLORS, RULER_HEIGHT_PX } from './theme';

/**
 * Scrollable/zoomable arrangement canvas: bar/beat ruler with loop range and
 * marker flags on top, track lanes with clip rectangles below, and a playhead
 * overlay. Rendering is split into a base layer (ruler, lanes, clips) and an
 * overlay layer (playhead) so playhead motion does not redraw the clips.
 *
 * MIDI clip bodies show mini-notes at high zoom and per-bar density blocks at
 * low zoom; audio clip bodies show a min/max waveform (with fade ramps and
 * fade handles) once their asset is loaded, and a placeholder centerline
 * before that. Expanded take sub-rows draw one block per take inside each
 * comped clip's span, highlighting the ranges the comp selection plays. Clip
 * gestures are delegated to the shared interactions state machine (take
 * sub-rows to the take machine); pressing the ruler seeks (and scrubs) the
 * transport via the `ruler-seek` emit.
 */

const props = defineProps<{
  /** Shared timeline viewport (this component owns its resize). */
  range: TimelineRange;
  /** Monotonic counter bumped by the container after view mutations. */
  revision: number;
  /** Shared frame batcher for canvas redraws. */
  painter: Painter;
  /** Tracks in lane order (index = lane index). */
  tracks: EditorTrack[];
  /** Clips to render (store mirror; the drag preview overrides geometry). */
  clips: EditorClip[];
  /** Timeline markers rendered as flags on the ruler. */
  markers: EditorMarker[];
  /** Id of the active track (its lane is tinted). */
  activeTrackId: number;
  /** Id of the active clip (rendered with a selection border). */
  activeClipId: number;
  /** Time-signature map driving the bar/beat ruler (4/4 when empty). */
  timeSignatures: TimeSignatureSegment[];
  /** Vertical scroll offset of the lane area in px. */
  scrollY: number;
  /** Height of one track lane in px. */
  laneHeight: number;
  /** Whether the transport loop range is shown on the ruler. */
  loopEnabled: boolean;
  /** Loop start in PPQ. */
  loopStartPpq: number;
  /** Loop end in PPQ. */
  loopEndPpq: number;
  /** Gesture state machine shared with the container. */
  interactions: ClipInteractions;
  /** Ids of tracks whose automation sublane is expanded. */
  automationExpandedIds: readonly number[];
  /** Selected automation parameter per track id (absent = 'faderDb'). */
  automationParams: Record<number, AutomationParam>;
  /** Automation lanes from the store (sublane curve source). */
  automationLanes: readonly AutomationLaneState[];
  /** Automation sublane gesture state machine shared with the container. */
  automation: AutomationInteractions;
  /** Ids of tracks whose take sub-rows are expanded. */
  takesExpandedIds: readonly number[];
  /** Take sub-row (comping) gesture state machine shared with the container. */
  takes: TakeInteractions;
  /** Playhead position getter in PPQ; omit to hide the playhead. */
  positionPpq?: () => number;
  /** Constant tempo in BPM used to map audio asset time onto PPQ (default 120). */
  tempoBpm?: number;
}>();

const { t } = useI18n();

const emit = defineEmits<{
  /** Fired after the canvas viewport was resized and the range re-clamped. */
  'view-resize': [widthPx: number, heightPx: number];
  /** Request to move the transport playhead (press or scrub on the ruler). */
  'ruler-seek': [ppq: number];
  /** Right-click on a clip lane: clipId is null when no clip was hit. */
  'clip-context': [payload: { x: number; y: number; clipId: number | null; ppq: number }];
  /** Right-click on the bar/beat ruler. */
  'ruler-context': [payload: { x: number; y: number; ppq: number }];
}>();

const wrapper = ref<HTMLDivElement | null>(null);
const baseCanvas = ref<HTMLCanvasElement | null>(null);
const overlayCanvas = ref<HTMLCanvasElement | null>(null);

/** Unique painter layer suffix so several surfaces can share one painter. */
const layerId = Math.random().toString(36).slice(2, 8);

/** Ruler ticks, cached: the grid and ruler request them twice per repaint. */
const cachedRulerTicks = createRulerTickCache();

const COLORS = ARRANGEMENT_COLORS;

/** Track lookup by id (color, name and lane index resolution). */
const trackIndexById = computed(() => {
  const map = new Map<number, number>();
  props.tracks.forEach((track, index) => {
    map.set(track.id, index);
  });
  return map;
});

/** Bar length in PPQ from the first meter segment (density bucket size). */
const barPpq = computed(() => {
  const segment = props.timeSignatures[0];
  return segment ? barLengthPpq(segment) : 4;
});

/** Row layout reflecting which tracks show take sub-rows or an automation sublane. */
const rowLayout = computed(() => {
  const expanded = new Set(props.automationExpandedIds);
  const takesExpanded = new Set(props.takesExpandedIds);
  return buildRowLayout(
    props.tracks.map((track) => expanded.has(track.id)),
    props.laneHeight,
    AUTOMATION_LANE_HEIGHT_PX,
    props.tracks.map((track) =>
      takesExpanded.has(track.id) ? trackTakeRowCount(props.clips, track.id) : 0,
    ),
  );
});

const activeClip = computed(() => props.clips.find((clip) => clip.id === props.activeClipId));

const liveStatus = computed(() => {
  const track = props.tracks.find((item) => item.id === props.activeTrackId);
  const parts: string[] = [];
  if (track) parts.push(`Track ${track.name} selected`);
  if (activeClip.value) parts.push(`Clip ${activeClip.value.name} selected`);
  else parts.push('No clip selected');
  parts.push(`${props.clips.length} clips on timeline`);
  return parts.join('. ');
});

function laneTopFor(index: number): number {
  return RULER_HEIGHT_PX + rowLayout.value.rowTop(index) - props.scrollY;
}

function scheduleBase(): void {
  props.painter.schedule(`arrangement-base-${layerId}`, drawBase);
}

/** Shared clip-rendering context rebuilt per base repaint. */
function clipRenderContext(): ClipRenderContext {
  return {
    range: props.range,
    tracks: props.tracks,
    trackIndexById: trackIndexById.value,
    laneHeight: props.laneHeight,
    laneTop: laneTopFor,
    barPpq: barPpq.value,
    tempoBpm: props.tempoBpm ?? 120,
    interactions: props.interactions,
    scheduleBase,
    colors: COLORS,
  };
}

/** Draws the full base layer: lanes, grid, clips, then the ruler on top. */
function drawBase(): void {
  const canvas = baseCanvas.value;
  if (!canvas) return;
  const ctx = getCanvasContext(canvas);
  if (!ctx) return;
  const w = props.range.widthPx;
  const h = props.range.heightPx;
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, w, h);
  drawLanes(ctx, w, h, {
    tracks: props.tracks,
    activeTrackId: props.activeTrackId,
    laneHeight: props.laneHeight,
    laneTop: laneTopFor,
    rowHeight: rowLayout.value.rowHeight,
    colors: COLORS,
  });
  drawGrid(ctx, h, {
    range: props.range,
    timeSignatures: props.timeSignatures,
    ticks: cachedRulerTicks,
    colors: COLORS,
  });
  drawClips(ctx, props.clips, props.activeClipId, clipRenderContext());
  drawTakeLanes(ctx, w, h, {
    range: props.range,
    tracks: props.tracks,
    clips: props.clips,
    takesExpandedIds: props.takesExpandedIds,
    takes: props.takes,
    scrollY: props.scrollY,
    takeTop: rowLayout.value.takeTop,
    colors: COLORS,
  });
  drawAutomationLanes(ctx, w, h, {
    range: props.range,
    tracks: props.tracks,
    automationExpandedIds: props.automationExpandedIds,
    automationParams: props.automationParams,
    automationLanes: props.automationLanes,
    automation: props.automation,
    scrollY: props.scrollY,
    automationTop: rowLayout.value.automationTop,
    colors: COLORS,
  });
  drawRuler(ctx, w, {
    range: props.range,
    timeSignatures: props.timeSignatures,
    ticks: cachedRulerTicks,
    markers: props.markers,
    loopEnabled: props.loopEnabled,
    loopStartPpq: props.loopStartPpq,
    loopEndPpq: props.loopEndPpq,
    colors: COLORS,
  });
}

const { scheduleOverlay } = usePlayheadOverlay({
  canvas: overlayCanvas,
  painter: props.painter,
  layerId,
  range: () => props.range,
  positionPpq: () => props.positionPpq,
  colors: COLORS,
});

function scheduleAll(): void {
  scheduleBase();
  scheduleOverlay();
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  const el = wrapper.value;
  if (!el) return;
  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    const w = entry.contentRect.width;
    const h = entry.contentRect.height;
    if (w <= 0 || h <= 0) return;
    props.range.resize(w, h);
    if (baseCanvas.value) setupCanvas(baseCanvas.value, w, h);
    if (overlayCanvas.value) setupCanvas(overlayCanvas.value, w, h);
    emit('view-resize', w, h);
    scheduleAll();
  });
  resizeObserver.observe(el);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

watch(
  () => [
    props.revision,
    props.tracks,
    props.clips,
    props.markers,
    props.activeTrackId,
    props.activeClipId,
    props.timeSignatures,
    props.scrollY,
    props.loopEnabled,
    props.loopStartPpq,
    props.loopEndPpq,
    props.tempoBpm,
    props.interactions.previewClip.value,
    props.interactions.previewFades.value,
    props.automationExpandedIds,
    props.automationParams,
    props.automationLanes,
    props.automation.preview.value,
    props.automation.hover.value,
    props.takesExpandedIds,
    props.takes.preview.value,
  ],
  scheduleAll,
);

// Pointer routing: ruler scrub vs automation vs takes vs clip gestures.
const {
  laneCursor,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onDoubleClick,
  onContextMenu,
} = usePointerRouting({
  wrapper,
  range: () => props.range,
  automation: props.automation,
  takes: props.takes,
  interactions: props.interactions,
  onRulerSeek: (ppq) => emit('ruler-seek', ppq),
  onRulerContext: (request) => emit('ruler-context', request),
  onClipContext: (request) => emit('clip-context', request),
});
</script>

<template>
  <div
    ref="wrapper"
    class="arrangement-canvas"
    :style="{ cursor: laneCursor }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @dblclick="onDoubleClick"
    @contextmenu="onContextMenu"
  >
    <canvas
      ref="baseCanvas"
      class="arrangement-layer"
      role="img"
      :aria-label="t.shell.arrangement.timeline"
    />
    <canvas ref="overlayCanvas" class="arrangement-layer" aria-hidden="true" />
    <div class="arrangement-live" role="status" aria-live="polite" aria-atomic="true">
      {{ liveStatus }}
    </div>
  </div>
</template>

<style scoped>
.arrangement-canvas {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: none;
}

.arrangement-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.arrangement-live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
