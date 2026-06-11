<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  fillRoundRect,
  getCanvasContext,
  setupCanvas,
  strokeRoundRect,
} from '@/components/piano-roll/theme';
import type { EditorClip, EditorMarker, EditorTrack, TimeSignatureSegment } from '@/project/types';
import { clipContentMode, densityBuckets, miniNoteRects } from '@/ui/arrangement/clip-content';
import { barLengthPpq, rulerTicks } from '@/ui/arrangement/ruler';
import type { ClipInteractions, ClipModifiers } from '@/ui/arrangement/use-clip-interactions';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { ARRANGEMENT_COLORS, colorWithAlpha, RULER_HEIGHT_PX } from './theme';

/**
 * Scrollable/zoomable arrangement canvas: bar/beat ruler with loop range and
 * marker flags on top, track lanes with clip rectangles below, and a playhead
 * overlay. Rendering is split into a base layer (ruler, lanes, clips) and an
 * overlay layer (playhead) so playhead motion does not redraw the clips.
 *
 * Clip bodies show mini-notes at high zoom and per-bar density blocks at low
 * zoom. Clip gestures are delegated to the shared interactions state machine;
 * pressing the ruler seeks (and scrubs) the transport via the `ruler-seek`
 * emit.
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
  /** Playhead position getter in PPQ; omit to hide the playhead. */
  positionPpq?: () => number;
}>();

const emit = defineEmits<{
  /** Fired after the canvas viewport was resized and the range re-clamped. */
  'view-resize': [widthPx: number, heightPx: number];
  /** Request to move the transport playhead (press or scrub on the ruler). */
  'ruler-seek': [ppq: number];
}>();

const wrapper = ref<HTMLDivElement | null>(null);
const baseCanvas = ref<HTMLCanvasElement | null>(null);
const overlayCanvas = ref<HTMLCanvasElement | null>(null);

/** Unique painter layer suffix so several surfaces can share one painter. */
const layerId = Math.random().toString(36).slice(2, 8);

const COLORS = ARRANGEMENT_COLORS;

/** Minimum clip width in px before the name label is drawn. */
const MIN_NAME_WIDTH_PX = 28;
/** Height of the name strip inside a clip body. */
const NAME_STRIP_PX = 13;

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

function laneTopFor(index: number): number {
  return RULER_HEIGHT_PX + index * props.laneHeight - props.scrollY;
}

function scheduleBase(): void {
  props.painter.schedule(`arrangement-base-${layerId}`, drawBase);
}

function scheduleOverlay(): void {
  props.painter.schedule(`arrangement-overlay-${layerId}`, drawOverlay);
}

function scheduleAll(): void {
  scheduleBase();
  scheduleOverlay();
}

/** Draws lane backgrounds, separators and the below-tracks shade. */
function drawLanes(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  for (let i = 0; i < props.tracks.length; i++) {
    const y = laneTopFor(i);
    if (y + props.laneHeight <= RULER_HEIGHT_PX || y >= h) continue;
    ctx.fillStyle = i % 2 === 0 ? COLORS.laneEven : COLORS.laneOdd;
    ctx.fillRect(0, y, w, props.laneHeight);
    if (props.tracks[i].id === props.activeTrackId) {
      ctx.fillStyle = COLORS.laneActive;
      ctx.fillRect(0, y, w, props.laneHeight);
    }
    ctx.fillStyle = COLORS.laneLine;
    ctx.fillRect(0, y + props.laneHeight - 1, w, 1);
  }
  const lanesEnd = laneTopFor(props.tracks.length);
  if (lanesEnd < h) {
    ctx.fillStyle = COLORS.beyondTracks;
    ctx.fillRect(
      0,
      Math.max(RULER_HEIGHT_PX, lanesEnd),
      w,
      h - Math.max(RULER_HEIGHT_PX, lanesEnd),
    );
  }
}

/** Draws beat/bar gridlines over the lane area. */
function drawGrid(ctx: CanvasRenderingContext2D, h: number): void {
  const range = props.range;
  const ticks = rulerTicks(props.timeSignatures, range.startPpq, range.endPpq, range.pxPerPpq);
  for (const tick of ticks) {
    ctx.fillStyle = tick.kind === 'bar' ? COLORS.gridBar : COLORS.gridBeat;
    ctx.fillRect(Math.round(range.ppqToX(tick.ppq)), RULER_HEIGHT_PX, 1, h - RULER_HEIGHT_PX);
  }
}

/** Draws one clip body (fill, content, name, border) at the given geometry. */
function drawClip(
  ctx: CanvasRenderingContext2D,
  source: EditorClip,
  geometry: { trackId: number; startPpq: number; lengthPpq: number },
  selected: boolean,
): void {
  const laneIndex = trackIndexById.value.get(geometry.trackId);
  if (laneIndex === undefined) return;
  const track = props.tracks[laneIndex];
  const range = props.range;
  const x = range.ppqToX(geometry.startPpq);
  const wPx = Math.max(2, geometry.lengthPpq * range.pxPerPpq - 1);
  if (x + wPx < 0 || x > range.widthPx) return;
  const y = laneTopFor(laneIndex) + 2;
  const hPx = props.laneHeight - 5;
  if (y + hPx < RULER_HEIGHT_PX || y > range.heightPx) return;

  ctx.fillStyle = colorWithAlpha(track.color, selected ? 0.4 : 0.26);
  fillRoundRect(ctx, x, y, wPx, hPx, 3);

  // Note content, clipped to the clip body.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, Math.max(y, RULER_HEIGHT_PX), wPx, hPx - Math.max(0, RULER_HEIGHT_PX - y));
  ctx.clip();
  const hasNameStrip = hPx >= 26 && wPx >= MIN_NAME_WIDTH_PX;
  const contentTop = hasNameStrip ? y + NAME_STRIP_PX : y + 2;
  const contentH = hPx - (hasNameStrip ? NAME_STRIP_PX + 2 : 4);
  if (contentH > 2 && source.notes.length > 0) {
    if (clipContentMode(range.pxPerPpq) === 'mini-notes') {
      ctx.fillStyle = colorWithAlpha(track.color, 0.95);
      for (const rect of miniNoteRects(source.notes, source.sourceOffsetPpq, source.lengthPpq)) {
        ctx.fillRect(
          x + rect.u * wPx,
          contentTop + rect.v * contentH,
          Math.max(1, rect.uWidth * wPx),
          Math.max(1.5, rect.vHeight * contentH),
        );
      }
    } else {
      const buckets = densityBuckets(
        source.notes,
        source.sourceOffsetPpq,
        source.lengthPpq,
        barPpq.value,
      );
      const bucketW = barPpq.value * range.pxPerPpq;
      for (let i = 0; i < buckets.length; i++) {
        if (buckets[i] <= 0) continue;
        ctx.fillStyle = colorWithAlpha(track.color, 0.12 + 0.5 * buckets[i]);
        const bx = x + i * bucketW;
        ctx.fillRect(bx, contentTop, Math.min(bucketW, x + wPx - bx), contentH);
      }
    }
  }
  if (hasNameStrip) {
    ctx.fillStyle = COLORS.clipName;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(source.name, Math.max(x, 0) + 5, y + 10);
  }
  ctx.restore();

  ctx.lineWidth = selected ? 1.5 : 1;
  ctx.strokeStyle = selected ? COLORS.clipSelectedBorder : COLORS.clipBorder;
  strokeRoundRect(ctx, x + 0.5, y + 0.5, wPx - 1, hPx - 1, 3);
}

/** Draws all clips, applying the in-flight drag preview when present. */
function drawClips(ctx: CanvasRenderingContext2D): void {
  const preview = props.interactions.previewClip.value;
  for (const clip of props.clips) {
    let geometry: { trackId: number; startPpq: number; lengthPpq: number } = clip;
    let selected = clip.id === props.activeClipId;
    if (preview && !preview.copy && preview.clipId === clip.id) {
      geometry = preview;
      selected = true;
    }
    drawClip(ctx, clip, geometry, selected);
  }
  if (preview?.copy) {
    const source = props.clips.find((clip) => clip.id === preview.clipId);
    if (source) drawClip(ctx, source, preview, true);
  }
}

/** Draws the ruler strip: loop band, ticks, labels and marker flags. */
function drawRuler(ctx: CanvasRenderingContext2D, w: number): void {
  const range = props.range;
  ctx.fillStyle = COLORS.rulerBackground;
  ctx.fillRect(0, 0, w, RULER_HEIGHT_PX);

  if (props.loopEnabled && props.loopEndPpq > props.loopStartPpq) {
    const x1 = Math.max(0, range.ppqToX(props.loopStartPpq));
    const x2 = Math.min(w, range.ppqToX(props.loopEndPpq));
    if (x2 > x1) {
      ctx.fillStyle = COLORS.loopOverlay;
      ctx.fillRect(x1, 0, x2 - x1, RULER_HEIGHT_PX);
    }
  }

  const ticks = rulerTicks(props.timeSignatures, range.startPpq, range.endPpq, range.pxPerPpq);
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const tick of ticks) {
    const x = Math.round(range.ppqToX(tick.ppq));
    if (tick.kind === 'bar') {
      ctx.fillStyle = COLORS.rulerBar;
      ctx.fillRect(x, RULER_HEIGHT_PX - 12, 1, 12);
      if (tick.label) {
        ctx.fillStyle = COLORS.rulerLabel;
        ctx.fillText(tick.label, x + 3, RULER_HEIGHT_PX - 16);
      }
    } else {
      ctx.fillStyle = COLORS.rulerBeat;
      ctx.fillRect(x, RULER_HEIGHT_PX - 6, 1, 6);
    }
  }

  for (const marker of props.markers) {
    const x = Math.round(range.ppqToX(marker.ppq));
    if (x < -40 || x > w) continue;
    ctx.fillStyle = COLORS.markerFlag;
    ctx.fillRect(x, 2, 1, RULER_HEIGHT_PX - 2);
    ctx.beginPath();
    ctx.moveTo(x, 2);
    ctx.lineTo(x + 7, 6);
    ctx.lineTo(x, 10);
    ctx.closePath();
    ctx.fill();
    if (marker.name) {
      ctx.fillStyle = COLORS.markerLabel;
      ctx.fillText(marker.name, x + 9, 10);
    }
  }

  ctx.fillStyle = COLORS.rulerBorder;
  ctx.fillRect(0, RULER_HEIGHT_PX - 1, w, 1);
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
  drawLanes(ctx, w, h);
  drawGrid(ctx, h);
  drawClips(ctx);
  drawRuler(ctx, w);
}

/** Draws the playhead line across the ruler and lanes. */
function drawOverlay(): void {
  const canvas = overlayCanvas.value;
  if (!canvas) return;
  const ctx = getCanvasContext(canvas);
  if (!ctx) return;
  const w = props.range.widthPx;
  const h = props.range.heightPx;
  ctx.clearRect(0, 0, w, h);
  if (props.positionPpq) {
    const x = props.range.ppqToX(props.positionPpq());
    if (x >= 0 && x <= w) {
      ctx.fillStyle = COLORS.playhead;
      ctx.fillRect(Math.round(x), 0, 1.5, h);
    }
  }
}

// Playhead polling: redraw the overlay only when the playhead px moved.
let playheadRaf: number | null = null;
let lastPlayheadX = Number.NaN;

function playheadTick(): void {
  const getter = props.positionPpq;
  if (getter) {
    const x = props.range.ppqToX(getter());
    if (x !== lastPlayheadX) {
      lastPlayheadX = x;
      scheduleOverlay();
    }
  }
  playheadRaf = requestAnimationFrame(playheadTick);
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
  playheadRaf = requestAnimationFrame(playheadTick);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (playheadRaf !== null) cancelAnimationFrame(playheadRaf);
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
    props.interactions.previewClip.value,
  ],
  scheduleAll,
);

// --- Pointer routing: ruler scrub vs clip gestures ------------------------

/** True while a ruler press scrubs the transport. */
let rulerScrub = false;

function localPoint(event: MouseEvent): { x: number; y: number } {
  const rect = wrapper.value?.getBoundingClientRect();
  return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
}

function modifiers(event: MouseEvent): ClipModifiers {
  return { alt: event.altKey, meta: event.metaKey || event.ctrlKey };
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  const point = localPoint(event);
  if (point.y < RULER_HEIGHT_PX) {
    rulerScrub = true;
    emit('ruler-seek', Math.max(0, props.range.xToPpq(point.x)));
    return;
  }
  props.interactions.onPointerDown(point, modifiers(event));
}

function onPointerMove(event: PointerEvent): void {
  const point = localPoint(event);
  if (rulerScrub) {
    emit('ruler-seek', Math.max(0, props.range.xToPpq(point.x)));
    return;
  }
  props.interactions.onPointerMove(point, modifiers(event));
}

function onPointerUp(event: PointerEvent): void {
  if (event.button !== 0) return;
  if (rulerScrub) {
    rulerScrub = false;
    return;
  }
  props.interactions.onPointerUp(localPoint(event), modifiers(event));
}

function onPointerCancel(): void {
  rulerScrub = false;
  props.interactions.cancel();
}

function onDoubleClick(event: MouseEvent): void {
  const point = localPoint(event);
  if (point.y < RULER_HEIGHT_PX) return;
  props.interactions.onDoubleClick(point, modifiers(event));
}
</script>

<template>
  <div
    ref="wrapper"
    class="arrangement-canvas"
    :style="{ cursor: props.interactions.cursor.value }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @dblclick="onDoubleClick"
  >
    <canvas ref="baseCanvas" class="arrangement-layer" />
    <canvas ref="overlayCanvas" class="arrangement-layer" />
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
</style>
