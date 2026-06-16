<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  fillRoundRect,
  getCanvasContext,
  setupCanvas,
  strokeRoundRect,
} from '@/components/piano-roll/theme';
import {
  type AutomationLaneState,
  type AutomationParam,
  evaluateAutomationValue,
} from '@/project/automation';
import { sanitizeCompSegments } from '@/project/comping';
import type { EditorClip, EditorMarker, EditorTrack, TimeSignatureSegment } from '@/project/types';
import { isAudioClip } from '@/project/types';
import {
  audioWindowFractions,
  peaksBucketCount,
  peaksBucketsPerSecond,
  waveformColumns,
} from '@/ui/arrangement/audio-clip-content';
import { audioAssetMergedPeaks, requestAudioAsset } from '@/ui/arrangement/audio-clip-data';
import { FADE_HANDLE_SIZE_PX, fadeHandleXs } from '@/ui/arrangement/audio-fades';
import {
  AUTOMATION_LANE_HEIGHT_PX,
  automationValueDomain,
  automationValueToY,
  buildRowLayout,
  TAKE_LANE_HEIGHT_PX,
  trackTakeRowCount,
} from '@/ui/arrangement/automation-rows';
import { clipContentMode, densityBuckets, miniNoteRects } from '@/ui/arrangement/clip-content';
import { barLengthPpq, createRulerTickCache } from '@/ui/arrangement/ruler';
import type { AutomationInteractions } from '@/ui/arrangement/use-automation-interactions';
import type { ClipInteractions, ClipModifiers } from '@/ui/arrangement/use-clip-interactions';
import type { TakeInteractions } from '@/ui/arrangement/use-take-interactions';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { useI18n } from '@/ui/i18n';
import { ARRANGEMENT_COLORS, colorWithAlpha, RULER_HEIGHT_PX } from './theme';

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

function laneTopFor(index: number): number {
  return RULER_HEIGHT_PX + rowLayout.value.rowTop(index) - props.scrollY;
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
    const rowHeight = rowLayout.value.rowHeight(i);
    if (y + rowHeight <= RULER_HEIGHT_PX || y >= h) continue;
    ctx.fillStyle = i % 2 === 0 ? COLORS.laneEven : COLORS.laneOdd;
    ctx.fillRect(0, y, w, rowHeight);
    if (props.tracks[i].id === props.activeTrackId) {
      ctx.fillStyle = COLORS.laneActive;
      ctx.fillRect(0, y, w, props.laneHeight);
    }
    ctx.fillStyle = COLORS.laneLine;
    ctx.fillRect(0, y + rowHeight - 1, w, 1);
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
  const ticks = cachedRulerTicks(
    props.timeSignatures,
    range.startPpq,
    range.endPpq,
    range.pxPerPpq,
  );
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
  if (contentH > 2 && isAudioClip(source)) {
    drawAudioWaveform(ctx, source, track.color, x, wPx, contentTop, contentH);
  } else if (contentH > 2 && source.notes.length > 0) {
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
  if (isAudioClip(source)) {
    drawAudioFades(ctx, source, x, y, wPx, hPx);
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

/**
 * Draws an audio clip's min/max waveform from the cached peak envelope of its
 * asset, picking the pyramid level from the horizontal zoom. While the asset
 * is still loading a placeholder centerline is drawn and a repaint is
 * scheduled for when the load settles.
 */
function drawAudioWaveform(
  ctx: CanvasRenderingContext2D,
  source: EditorClip,
  color: string,
  x: number,
  wPx: number,
  contentTop: number,
  contentH: number,
): void {
  const range = props.range;
  const centerY = contentTop + contentH / 2;
  const asset = source.assetId ? requestAudioAsset(source.assetId, scheduleBase) : null;
  if (!asset || !source.assetId) {
    ctx.fillStyle = colorWithAlpha(color, 0.45);
    ctx.fillRect(x, centerY - 0.5, wPx, 1);
    return;
  }
  const visibleLeft = Math.max(x, 0);
  const visibleRight = Math.min(x + wPx, range.widthPx);
  if (visibleRight <= visibleLeft || !(wPx > 0)) return;
  const tempoBpm = props.tempoBpm ?? 120;
  const meta = asset.meta;
  const pxPerSecond = range.pxPerPpq * (tempoBpm / 60);
  const bucketCount = peaksBucketCount(
    meta.numFrames,
    meta.sampleRate,
    peaksBucketsPerSecond(pxPerSecond),
  );
  const peaks = audioAssetMergedPeaks(source.assetId, asset, bucketCount);
  const window = audioWindowFractions(
    source.sourceOffsetPpq,
    source.lengthPpq,
    tempoBpm,
    meta.numFrames,
    meta.sampleRate,
  );
  // Map only the on-screen slice of the clip window to pixel columns.
  const span = window.endFrac - window.startFrac;
  const columnCount = Math.max(1, Math.round(visibleRight - visibleLeft));
  const columns = waveformColumns(
    peaks,
    window.startFrac + ((visibleLeft - x) / wPx) * span,
    window.startFrac + ((visibleRight - x) / wPx) * span,
    columnCount,
  );
  ctx.fillStyle = colorWithAlpha(color, 0.9);
  const half = contentH / 2;
  for (let j = 0; j < columns.length; j++) {
    const col = columns[j];
    const top = centerY - col.max * half;
    const height = Math.max(1, (col.max - col.min) * half);
    ctx.fillRect(visibleLeft + j, top, 1, height);
  }
}

/** Draws the fade ramps, shaded corners and top fade handles of an audio clip. */
function drawAudioFades(
  ctx: CanvasRenderingContext2D,
  source: EditorClip,
  x: number,
  y: number,
  wPx: number,
  hPx: number,
): void {
  const preview = props.interactions.previewFades.value;
  const fades =
    preview && preview.clipId === source.id
      ? preview
      : { fadeInPpq: source.fadeInPpq ?? 0, fadeOutPpq: source.fadeOutPpq ?? 0 };
  const pxPerPpq = props.range.pxPerPpq;
  const bottom = y + hPx;
  const fadeInPx = Math.min(wPx, fades.fadeInPpq * pxPerPpq);
  const fadeOutPx = Math.min(wPx, fades.fadeOutPpq * pxPerPpq);
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.fadeRamp;
  if (fadeInPx > 0) {
    ctx.fillStyle = COLORS.fadeOverlay;
    ctx.beginPath();
    ctx.moveTo(x, bottom);
    ctx.lineTo(x, y);
    ctx.lineTo(x + fadeInPx, y);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x, bottom);
    ctx.lineTo(x + fadeInPx, y);
    ctx.stroke();
  }
  if (fadeOutPx > 0) {
    ctx.fillStyle = COLORS.fadeOverlay;
    ctx.beginPath();
    ctx.moveTo(x + wPx, bottom);
    ctx.lineTo(x + wPx, y);
    ctx.lineTo(x + wPx - fadeOutPx, y);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + wPx - fadeOutPx, y);
    ctx.lineTo(x + wPx, bottom);
    ctx.stroke();
  }
  if (wPx >= FADE_HANDLE_SIZE_PX * 2) {
    const xs = fadeHandleXs(x, x + wPx, fades.fadeInPpq, fades.fadeOutPpq, pxPerPpq);
    drawFadeHandle(ctx, xs.inX, y);
    drawFadeHandle(ctx, xs.outX, y);
  }
}

/** Draws one downward-pointing fade handle triangle at the clip top edge. */
function drawFadeHandle(ctx: CanvasRenderingContext2D, handleX: number, top: number): void {
  const half = FADE_HANDLE_SIZE_PX / 2;
  ctx.fillStyle = COLORS.fadeHandle;
  ctx.beginPath();
  ctx.moveTo(handleX - half, top + 1);
  ctx.lineTo(handleX + half, top + 1);
  ctx.lineTo(handleX, top + 1 + FADE_HANDLE_SIZE_PX);
  ctx.closePath();
  ctx.fill();
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
  const draft = props.interactions.previewDraft.value;
  if (draft) drawDraft(ctx, draft);
}

/** Draws the draw-tool draft outline (a dashed accent rectangle). */
function drawDraft(
  ctx: CanvasRenderingContext2D,
  draft: { trackId: number; startPpq: number; lengthPpq: number },
): void {
  const laneIndex = trackIndexById.value.get(draft.trackId);
  if (laneIndex === undefined) return;
  const range = props.range;
  const x = range.ppqToX(draft.startPpq);
  const wPx = Math.max(2, draft.lengthPpq * range.pxPerPpq - 1);
  if (x + wPx < 0 || x > range.widthPx) return;
  const y = laneTopFor(laneIndex) + 2;
  const hPx = props.laneHeight - 5;
  ctx.fillStyle = COLORS.draftFill;
  fillRoundRect(ctx, x, y, wPx, hPx, 3);
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.draftStroke;
  strokeRoundRect(ctx, x + 0.5, y + 0.5, wPx - 1, hPx - 1, 3);
}

/** Px step between automation curve samples along the x axis. */
const AUTOMATION_SAMPLE_STEP_PX = 2;
/** Radius of an automation breakpoint circle in px. */
const AUTOMATION_POINT_RADIUS_PX = 3.5;
/** Alpha applied to a disabled lane's curve and breakpoints. */
const AUTOMATION_DISABLED_ALPHA = 0.35;

/** Draws every expanded automation sublane: shade, curve and breakpoints. */
function drawAutomationLanes(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const expanded = new Set(props.automationExpandedIds);
  for (let i = 0; i < props.tracks.length; i++) {
    const track = props.tracks[i];
    if (!expanded.has(track.id)) continue;
    const top = RULER_HEIGHT_PX + rowLayout.value.automationTop(i) - props.scrollY;
    const height = AUTOMATION_LANE_HEIGHT_PX;
    if (top + height <= RULER_HEIGHT_PX || top >= h) continue;
    drawAutomationSublane(ctx, w, track, top, height);
  }
}

/** Vertical inset of a take block inside its sub-row, in px. */
const TAKE_BLOCK_PAD_PX = 3;

/** Draws every expanded take sub-row area: shade, separators and take blocks. */
function drawTakeLanes(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const takesExpanded = new Set(props.takesExpandedIds);
  for (let i = 0; i < props.tracks.length; i++) {
    const track = props.tracks[i];
    if (!takesExpanded.has(track.id)) continue;
    const rowCount = trackTakeRowCount(props.clips, track.id);
    if (rowCount === 0) continue;
    const top = RULER_HEIGHT_PX + rowLayout.value.takeTop(i, 0) - props.scrollY;
    const height = rowCount * TAKE_LANE_HEIGHT_PX;
    if (top + height <= RULER_HEIGHT_PX || top >= h) continue;
    ctx.fillStyle = COLORS.takeLane;
    ctx.fillRect(0, top, w, height);
    ctx.fillStyle = COLORS.laneLine;
    for (let k = 1; k < rowCount; k++) {
      ctx.fillRect(0, top + k * TAKE_LANE_HEIGHT_PX, w, 1);
    }
    for (const clip of props.clips) {
      if (clip.trackId !== track.id || (clip.takes?.length ?? 0) === 0) continue;
      drawClipTakeBlocks(ctx, clip, track, top);
    }
  }
}

/**
 * Draws one comped clip's take blocks: in take sub-row k a subtle block over
 * the clip's span, a stronger fill on the ranges where the comp selection
 * plays take k and, while a comp drag runs, a highlight over the dragged
 * range.
 */
function drawClipTakeBlocks(
  ctx: CanvasRenderingContext2D,
  clip: EditorClip,
  track: EditorTrack,
  top: number,
): void {
  const range = props.range;
  const takes = clip.takes ?? [];
  const x = range.ppqToX(clip.startPpq);
  const wPx = Math.max(2, clip.lengthPpq * range.pxPerPpq - 1);
  if (x + wPx < 0 || x > range.widthPx) return;
  const selection = sanitizeCompSegments(
    clip.compSegments && clip.compSegments.length > 0
      ? clip.compSegments
      : [{ startPpq: 0, takeIndex: 0 }],
    takes.length,
    clip.lengthPpq,
  );
  const preview = props.takes.preview.value;
  for (let k = 0; k < takes.length; k++) {
    const y = top + k * TAKE_LANE_HEIGHT_PX + TAKE_BLOCK_PAD_PX;
    const hPx = TAKE_LANE_HEIGHT_PX - 2 * TAKE_BLOCK_PAD_PX;
    ctx.fillStyle = colorWithAlpha(track.color, 0.14);
    fillRoundRect(ctx, x, y, wPx, hPx, 2);
    ctx.fillStyle = colorWithAlpha(track.color, 0.55);
    for (let s = 0; s < selection.length; s++) {
      if (selection[s].takeIndex !== k) continue;
      const segStart = selection[s].startPpq;
      const segEnd = s + 1 < selection.length ? selection[s + 1].startPpq : clip.lengthPpq;
      const sx = range.ppqToX(clip.startPpq + segStart);
      const sw = Math.max(1, (segEnd - segStart) * range.pxPerPpq - 1);
      ctx.fillRect(sx, y, sw, hPx);
    }
    if (
      preview &&
      preview.clipId === clip.id &&
      preview.takeIndex === k &&
      preview.endPpq > preview.startPpq
    ) {
      ctx.fillStyle = colorWithAlpha(track.color, 0.75);
      const px = range.ppqToX(clip.startPpq + preview.startPpq);
      const pw = Math.max(1, (preview.endPpq - preview.startPpq) * range.pxPerPpq);
      ctx.fillRect(px, y, pw, hPx);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.clipBorder;
    strokeRoundRect(ctx, x + 0.5, y + 0.5, wPx - 1, hPx - 1, 2);
  }
}

/** Draws one sublane: darker shade, mid-value line, curve and breakpoints. */
function drawAutomationSublane(
  ctx: CanvasRenderingContext2D,
  w: number,
  track: EditorTrack,
  top: number,
  height: number,
): void {
  const range = props.range;
  const param = props.automationParams[track.id] ?? 'faderDb';
  ctx.save();
  ctx.beginPath();
  const clipTop = Math.max(top, RULER_HEIGHT_PX);
  ctx.rect(0, clipTop, w, top + height - clipTop);
  ctx.clip();
  ctx.fillStyle = COLORS.automationLane;
  ctx.fillRect(0, top, w, height);
  const domain = automationValueDomain(param);
  const midY = automationValueToY(param, (domain.min + domain.max) / 2, top, height);
  ctx.fillStyle = COLORS.automationMidline;
  ctx.fillRect(0, Math.round(midY), w, 1);

  const lane =
    props.automationLanes.find((l) => l.target === track.id && l.param === param) ?? null;
  const preview = props.automation.preview.value;
  const previewing = preview !== null && preview.trackId === track.id && preview.param === param;
  const points = previewing ? preview.points : (lane?.points ?? []);
  if (points.length === 0) {
    ctx.restore();
    return;
  }
  if (lane && !lane.enabled) ctx.globalAlpha = AUTOMATION_DISABLED_ALPHA;

  // Curve polyline: regular x samples plus the exact breakpoint vertices.
  const xs: number[] = [];
  for (let x = 0; x <= w; x += AUTOMATION_SAMPLE_STEP_PX) xs.push(x);
  for (const point of points) {
    const x = range.ppqToX(point.ppq);
    if (x > 0 && x < w) xs.push(x);
  }
  xs.sort((a, b) => a - b);
  ctx.strokeStyle = colorWithAlpha(track.color, 0.9);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < xs.length; i++) {
    const value = evaluateAutomationValue(points, range.xToPpq(xs[i]));
    const y = automationValueToY(param, value, top, height);
    if (i === 0) ctx.moveTo(xs[i], y);
    else ctx.lineTo(xs[i], y);
  }
  ctx.stroke();

  const hover = props.automation.hover.value;
  for (let i = 0; i < points.length; i++) {
    const x = range.ppqToX(points[i].ppq);
    if (x < -AUTOMATION_POINT_RADIUS_PX || x > w + AUTOMATION_POINT_RADIUS_PX) continue;
    const y = automationValueToY(param, points[i].value, top, height);
    const hovered =
      !previewing &&
      hover !== null &&
      hover.trackId === track.id &&
      hover.param === param &&
      hover.index === i;
    ctx.fillStyle = hovered ? COLORS.automationPointHover : track.color;
    ctx.beginPath();
    ctx.arc(x, y, AUTOMATION_POINT_RADIUS_PX, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
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

  const ticks = cachedRulerTicks(
    props.timeSignatures,
    range.startPpq,
    range.endPpq,
    range.pxPerPpq,
  );
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
  drawTakeLanes(ctx, w, h);
  drawAutomationLanes(ctx, w, h);
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

// --- Pointer routing: ruler scrub vs automation vs takes vs clip gestures --

/** True while a ruler press scrubs the transport. */
let rulerScrub = false;

/** Which gesture machine consumed the current press. */
let pressTarget: 'none' | 'automation' | 'takes' | 'clips' = 'none';

/** Cursor over the lanes: a hot sublane (automation, then takes) wins. */
const laneCursor = computed(
  () =>
    props.automation.cursor.value ?? props.takes.cursor.value ?? props.interactions.cursor.value,
);

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
  if (props.automation.onPointerDown(point, modifiers(event))) {
    pressTarget = 'automation';
    return;
  }
  if (props.takes.onPointerDown(point)) {
    pressTarget = 'takes';
    return;
  }
  pressTarget = 'clips';
  props.interactions.onPointerDown(point, modifiers(event));
}

function onPointerMove(event: PointerEvent): void {
  const point = localPoint(event);
  if (rulerScrub) {
    emit('ruler-seek', Math.max(0, props.range.xToPpq(point.x)));
    return;
  }
  // While a press is in flight, only its own machine sees the moves.
  if (pressTarget === 'automation') {
    props.automation.onPointerMove(point, modifiers(event));
    return;
  }
  if (pressTarget === 'takes') {
    props.takes.onPointerMove(point);
    return;
  }
  if (pressTarget === 'clips') {
    props.interactions.onPointerMove(point, modifiers(event));
    return;
  }
  if (props.automation.onPointerMove(point, modifiers(event))) return;
  if (props.takes.onPointerMove(point)) return;
  props.interactions.onPointerMove(point, modifiers(event));
}

function onPointerUp(event: PointerEvent): void {
  if (event.button !== 0) return;
  if (rulerScrub) {
    rulerScrub = false;
    return;
  }
  const target = pressTarget;
  pressTarget = 'none';
  if (target === 'automation') {
    props.automation.onPointerUp(localPoint(event), modifiers(event));
    return;
  }
  if (target === 'takes') {
    props.takes.onPointerUp(localPoint(event));
    return;
  }
  props.interactions.onPointerUp(localPoint(event), modifiers(event));
}

function onPointerCancel(): void {
  rulerScrub = false;
  pressTarget = 'none';
  props.automation.cancel();
  props.takes.cancel();
  props.interactions.cancel();
}

function onDoubleClick(event: MouseEvent): void {
  const point = localPoint(event);
  if (point.y < RULER_HEIGHT_PX) return;
  if (props.automation.onDoubleClick(point)) return;
  props.interactions.onDoubleClick(point, modifiers(event));
}

function onContextMenu(event: MouseEvent): void {
  const point = localPoint(event);
  // The automation sublane owns its own point menu; defer to it first.
  if (props.automation.onContextMenu(point)) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  const ppq = Math.max(0, props.range.xToPpq(point.x));
  if (point.y < RULER_HEIGHT_PX) {
    emit('ruler-context', { x: event.clientX, y: event.clientY, ppq });
    return;
  }
  emit('clip-context', {
    x: event.clientX,
    y: event.clientY,
    clipId: props.interactions.hitClipAt(point),
    ppq,
  });
}
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
