<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AccessibleObjectNavigator from '@/components/accessibility/AccessibleObjectNavigator.vue';
import { getCanvasContext, setupCanvas } from '@/components/piano-roll/theme';
import type { AutomationLaneState, AutomationParam } from '@/project/automation';
import type { PpqSpan } from '@/project/take-silence';
import { DEFAULT_TEMPO_BPM, normalizeTempoMap } from '@/project/tempo-map';
import type {
  EditorClip,
  EditorMarker,
  EditorTrack,
  TempoSegment,
  TimeSignatureSegment,
} from '@/project/types';
import type {
  AccessibleObjectAdjustment,
  AccessibleObjectItem,
} from '@/ui/accessibility/object-navigation';
import { type ArrangementRowLayout } from '@/ui/arrangement/automation-rows';
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
import { observeDevicePixelRatio } from '@/ui/canvas/device-pixel-ratio';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { formatMessage, useI18n } from '@/ui/i18n';
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
  /** Arrangement clips selected together (all render with a selection border). */
  selectedClipIds?: ReadonlySet<number>;
  /** Time-signature map driving the bar/beat ruler (4/4 when empty). */
  timeSignatures: TimeSignatureSegment[];
  /** Vertical scroll offset of the lane area in px. */
  scrollY: number;
  /** Height of one track lane in px. */
  laneHeight: number;
  /** Shared row geometry from the arrangement container. */
  rowLayout: ArrangementRowLayout;
  /** Whether the transport loop range is shown on the ruler. */
  loopEnabled: boolean;
  /** Loop start in PPQ. */
  loopStartPpq: number;
  /** Loop end in PPQ. */
  loopEndPpq: number;
  /** Gesture state machine shared with the container. */
  interactions: ClipInteractions;
  /** Keyboard/slider movement increment in PPQ. */
  gridPpq?: number;
  /** Resolves ruler seeks on the arrangement's meter-aware snap grid. */
  snapPpq?: (ppq: number) => number;
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
  /** Clip-relative spans where every take of a clip is silent, by clip id. */
  takeSilence?: ReadonlyMap<number, ReadonlyArray<PpqSpan>>;
  /** Playhead position getter in PPQ; omit to hide the playhead. */
  positionPpq?: () => number;
  /** Fixed local column to pin the playhead to while following, else null. */
  anchoredLocalX?: () => number | null;
  /** Constant tempo in BPM used to map audio asset time onto PPQ (default 120). */
  tempoBpm?: number;
  /** Full tempo map used for variable-tempo waveform/source mapping. */
  tempoSegments?: TempoSegment[];
}>();

const { t } = useI18n();

const emit = defineEmits<{
  /** Fired after the canvas viewport was resized and the range re-clamped. */
  'view-resize': [widthPx: number, heightPx: number];
  /** Request to move the transport playhead (press or scrub on the ruler). */
  'ruler-seek': [ppq: number];
  /** Request to set and enable a loop range from an upper-ruler drag. */
  'loop-range': [startPpq: number, endPpq: number];
  /** Right-click on a clip lane: clipId is null when no clip was hit. */
  'clip-context': [payload: { x: number; y: number; clipId: number | null; ppq: number }];
  /** Right-click on the bar/beat ruler. */
  'ruler-context': [payload: { x: number; y: number; ppq: number }];
  /** Accessible virtual-object edit routed to the owning command surface. */
  'clip-keyboard-action': [
    payload:
      | { clipId: number; kind: 'select' }
      | { clipId: number; kind: 'adjust'; adjustment: AccessibleObjectAdjustment }
      | { clipId: number; kind: 'set'; controlId: string; value: number },
  ];
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

/** Tempo map for audio source mapping, rebuilt only when its inputs change. */
const tempoMap = computed(() =>
  normalizeTempoMap(props.tempoSegments ?? [], props.tempoBpm ?? DEFAULT_TEMPO_BPM),
);

const activeClip = computed(() => props.clips.find((clip) => clip.id === props.activeClipId));

const liveStatus = computed(() => {
  const track = props.tracks.find((item) => item.id === props.activeTrackId);
  const parts: string[] = [];
  if (track) {
    parts.push(
      formatMessage(t.value.shell.arrangement.accessibility.trackSelected, { name: track.name }),
    );
  }
  if (activeClip.value) {
    parts.push(
      formatMessage(t.value.shell.arrangement.accessibility.clipSelected, {
        name: activeClip.value.name,
      }),
    );
  } else parts.push(t.value.shell.arrangement.accessibility.noClipSelected);
  parts.push(
    formatMessage(t.value.shell.arrangement.accessibility.timelineClipCount, {
      count: props.clips.length,
    }),
  );
  return parts.join('. ');
});

const accessibleClips = computed<AccessibleObjectItem[]>(() => {
  let maximumEnd = props.range.endPpq;
  for (const clip of props.clips) maximumEnd = Math.max(maximumEnd, clip.startPpq + clip.lengthPpq);
  const trackById = new Map(props.tracks.map((item) => [item.id, item]));
  const step = Math.max(0.0625, props.gridPpq ?? 0.25);
  return [...props.clips]
    .sort((a, b) => a.startPpq - b.startPpq || a.trackId - b.trackId || a.id - b.id)
    .map((clip) => {
      const track = trackById.get(clip.trackId);
      const values = {
        name: clip.name,
        track: track?.name ?? String(clip.trackId),
        start: clip.startPpq.toFixed(2),
        length: clip.lengthPpq.toFixed(2),
      };
      return {
        id: `clip-${clip.id}`,
        label: formatMessage(t.value.shell.arrangement.accessibility.clip, values),
        selected: clip.id === props.activeClipId,
        controls: [
          {
            id: 'start',
            label: t.value.shell.arrangement.accessibility.start,
            min: 0,
            max: Math.max(maximumEnd, clip.startPpq),
            step,
            value: clip.startPpq,
            valueText: formatMessage(t.value.shell.arrangement.accessibility.ppqValue, {
              value: clip.startPpq.toFixed(2),
            }),
          },
          {
            id: 'length',
            label: t.value.shell.arrangement.accessibility.length,
            min: 0.25,
            max: Math.max(maximumEnd, clip.lengthPpq),
            step,
            value: clip.lengthPpq,
            valueText: formatMessage(t.value.shell.arrangement.accessibility.ppqValue, {
              value: clip.lengthPpq.toFixed(2),
            }),
          },
        ],
      };
    });
});

function clipForAccessibleId(id: string): EditorClip | undefined {
  const clipId = Number(id.replace(/^clip-/, ''));
  return props.clips.find((clip) => clip.id === clipId);
}

function onAccessibleClipActivate(id: string): void {
  const clip = clipForAccessibleId(id);
  if (!clip) return;
  props.interactions.cancel();
  emit('clip-keyboard-action', { clipId: clip.id, kind: 'select' });
}

function onAccessibleClipContext(id: string): void {
  const clip = clipForAccessibleId(id);
  if (!clip) return;
  const rect = wrapper.value?.getBoundingClientRect();
  emit('clip-context', {
    x: (rect?.left ?? 0) + 24,
    y: (rect?.top ?? 0) + 48,
    clipId: clip.id,
    ppq: clip.startPpq + clip.lengthPpq / 2,
  });
}

function onAccessibleClipAdjust(adjustment: AccessibleObjectAdjustment): void {
  const clip = clipForAccessibleId(adjustment.id);
  if (clip) emit('clip-keyboard-action', { clipId: clip.id, kind: 'adjust', adjustment });
}

function onAccessibleClipValue(payload: { id: string; controlId: string; value: number }): void {
  const clip = clipForAccessibleId(payload.id);
  if (clip) emit('clip-keyboard-action', { clipId: clip.id, kind: 'set', ...payload });
}

function laneTopFor(index: number): number {
  return RULER_HEIGHT_PX + props.rowLayout.rowTop(index) - props.scrollY;
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
    tempoMap: tempoMap.value,
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
    rowHeight: props.rowLayout.rowHeight,
    colors: COLORS,
  });
  drawGrid(ctx, h, {
    range: props.range,
    timeSignatures: props.timeSignatures,
    ticks: cachedRulerTicks,
    colors: COLORS,
  });
  drawClips(ctx, props.clips, props.activeClipId, clipRenderContext(), props.selectedClipIds);
  drawTakeLanes(ctx, w, h, {
    range: props.range,
    tracks: props.tracks,
    clips: props.clips,
    takesExpandedIds: props.takesExpandedIds,
    takes: props.takes,
    takeSilence: props.takeSilence,
    scrollY: props.scrollY,
    takeTop: props.rowLayout.takeTop,
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
    automationTop: props.rowLayout.automationTop,
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
  anchoredLocalX: () => props.anchoredLocalX?.() ?? null,
  colors: COLORS,
});

function scheduleAll(): void {
  scheduleBase();
  scheduleOverlay();
}

let resizeObserver: ResizeObserver | null = null;
let stopDprObserver: (() => void) | null = null;
let canvasWidth = 0;
let canvasHeight = 0;

/** Rebuilds both backing stores when the window crosses a DPR boundary. */
function onDevicePixelRatioChange(): void {
  if (canvasWidth > 0 && canvasHeight > 0) {
    if (baseCanvas.value) setupCanvas(baseCanvas.value, canvasWidth, canvasHeight);
    if (overlayCanvas.value) setupCanvas(overlayCanvas.value, canvasWidth, canvasHeight);
    scheduleAll();
  }
}

onMounted(() => {
  const el = wrapper.value;
  if (!el) return;
  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    const w = entry.contentRect.width;
    const h = entry.contentRect.height;
    if (w <= 0 || h <= 0) return;
    canvasWidth = w;
    canvasHeight = h;
    props.range.resize(w, h);
    if (baseCanvas.value) setupCanvas(baseCanvas.value, w, h);
    if (overlayCanvas.value) setupCanvas(overlayCanvas.value, w, h);
    emit('view-resize', w, h);
    scheduleAll();
  });
  resizeObserver.observe(el);
  stopDprObserver = observeDevicePixelRatio(onDevicePixelRatioChange);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  stopDprObserver?.();
  stopDprObserver = null;
});

watch(
  () => [
    props.revision,
    props.tracks,
    props.clips,
    props.takeSilence,
    props.markers,
    props.activeTrackId,
    props.activeClipId,
    props.selectedClipIds,
    props.timeSignatures,
    props.scrollY,
    props.loopEnabled,
    props.loopStartPpq,
    props.loopEndPpq,
    props.tempoBpm,
    props.tempoSegments,
    props.laneHeight,
    props.rowLayout,
    props.interactions.previewClip.value,
    props.interactions.previewClips?.value,
    props.interactions.previewMarquee?.value,
    props.interactions.previewDraft?.value,
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
  cancelAll,
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
  onRulerSeek: (ppq, bypassSnap) =>
    emit('ruler-seek', bypassSnap ? ppq : (props.snapPpq?.(ppq) ?? ppq)),
  onRulerLoopRange: (startPpq, endPpq, bypassSnap) => {
    const start = bypassSnap ? startPpq : (props.snapPpq?.(startPpq) ?? startPpq);
    const end = bypassSnap ? endPpq : (props.snapPpq?.(endPpq) ?? endPpq);
    if (end > start) emit('loop-range', start, end);
  },
  onRulerContext: (request) => emit('ruler-context', request),
  onClipContext: (request) => emit('clip-context', request),
});

function onEscape(): void {
  cancelAll();
}
</script>

<template>
  <div
    ref="wrapper"
    class="arrangement-canvas"
    tabindex="0"
    :style="{ cursor: laneCursor }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @dblclick="onDoubleClick"
    @contextmenu="onContextMenu"
    @keydown.escape.prevent="onEscape"
  >
    <canvas
      ref="baseCanvas"
      class="arrangement-layer"
      role="img"
      :aria-label="t.shell.arrangement.timeline"
    />
    <canvas ref="overlayCanvas" class="arrangement-layer" aria-hidden="true" />
    <AccessibleObjectNavigator
      :label="t.shell.arrangement.accessibility.navigator"
      :empty-label="t.shell.arrangement.accessibility.empty"
      :instructions="t.shell.arrangement.accessibility.instructions"
      :edit-label="t.shell.arrangement.accessibility.edit"
      :context-label="t.shell.arrangement.accessibility.context"
      :items="accessibleClips"
      @activate="onAccessibleClipActivate"
      @context="onAccessibleClipContext"
      @adjust="onAccessibleClipAdjust"
      @set-value="onAccessibleClipValue"
    />
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
