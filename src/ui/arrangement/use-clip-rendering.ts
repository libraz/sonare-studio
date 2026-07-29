/**
 * Clip-body rendering for the arrangement base layer: fill, note content
 * (MIDI mini-notes or per-bar density blocks), audio waveform peak envelope,
 * fade ramps and handles, the name strip and the selection border, plus the
 * draw-tool draft outline. The in-flight drag preview overrides clip geometry.
 *
 * Pure drawing helpers: each takes the 2D context plus an explicit parameter
 * object bundling the data the canvas owns, so geometry, colors and pixel
 * boundaries are computed exactly as before.
 */

import {
  type ARRANGEMENT_COLORS,
  colorWithAlpha,
  RULER_HEIGHT_PX,
} from '@/components/arrangement/theme';
import { fillRoundRect, strokeRoundRect } from '@/components/piano-roll/theme';
import { type NormalizedTempoMap, tempoAtPpq } from '@/project/tempo-map';
import type { EditorClip, EditorTrack } from '@/project/types';
import { isAudioClip } from '@/project/types';
import {
  audioWindowFractions,
  peaksBucketCount,
  peaksBucketsPerSecond,
  warpedWaveformColumns,
  waveformColumns,
} from '@/ui/arrangement/audio-clip-content';
import { audioAssetMergedPeaks, requestAudioAsset } from '@/ui/arrangement/audio-clip-data';
import { FADE_HANDLE_SIZE_PX, fadeHandleXs } from '@/ui/arrangement/audio-fades';
import {
  arrangementMidiNoteSpans,
  type ClipNoteSpan,
  clipContentMode,
  densityBuckets,
  miniNoteRects,
  type UnitRect,
} from '@/ui/arrangement/clip-content';
import type { ClipInteractions } from '@/ui/arrangement/use-clip-interactions';
import type { TimelineRange } from '@/ui/canvas/timeline-range';

type ArrangementColors = typeof ARRANGEMENT_COLORS;

// Per-clip memo of the zoom-dependent note-content geometry. The arrangement
// repaints its entire base layer on every playhead-follow frame, but a clip's
// mini-note rects and per-bar densities depend only on its note array and
// window — both immutable during playback — not on the horizontal scroll.
// Keyed by the note array identity: an edit rebuilds that array (store refresh
// or command-history clone), so it misses and recomputes, and the entry is
// dropped automatically once the old array is no longer referenced.
interface MiniNoteCacheEntry {
  windowStartPpq: number;
  windowLengthPpq: number;
  rects: UnitRect[];
}
const miniNoteRectsCache = new WeakMap<ReadonlyArray<ClipNoteSpan>, MiniNoteCacheEntry>();

function cachedMiniNoteRects(
  notes: ReadonlyArray<ClipNoteSpan>,
  windowStartPpq: number,
  windowLengthPpq: number,
): UnitRect[] {
  const hit = miniNoteRectsCache.get(notes);
  if (hit && hit.windowStartPpq === windowStartPpq && hit.windowLengthPpq === windowLengthPpq) {
    return hit.rects;
  }
  const rects = miniNoteRects(notes, windowStartPpq, windowLengthPpq);
  miniNoteRectsCache.set(notes, { windowStartPpq, windowLengthPpq, rects });
  return rects;
}

interface DensityCacheEntry {
  windowStartPpq: number;
  windowLengthPpq: number;
  bucketPpq: number;
  densities: number[];
}
const densityBucketsCache = new WeakMap<ReadonlyArray<ClipNoteSpan>, DensityCacheEntry>();

function cachedDensityBuckets(
  notes: ReadonlyArray<ClipNoteSpan>,
  windowStartPpq: number,
  windowLengthPpq: number,
  bucketPpq: number,
): number[] {
  const hit = densityBucketsCache.get(notes);
  if (
    hit &&
    hit.windowStartPpq === windowStartPpq &&
    hit.windowLengthPpq === windowLengthPpq &&
    hit.bucketPpq === bucketPpq
  ) {
    return hit.densities;
  }
  const densities = densityBuckets(notes, windowStartPpq, windowLengthPpq, bucketPpq);
  densityBucketsCache.set(notes, { windowStartPpq, windowLengthPpq, bucketPpq, densities });
  return densities;
}

interface ArrangementNoteSpanCacheEntry {
  sourceNotes: EditorClip['notes'];
  startPpq: number;
  lengthPpq: number;
  sourceOffsetPpq: number;
  loopEnabled: boolean;
  loopLengthPpq: number;
  spans: ClipNoteSpan[];
}
const arrangementNoteSpanCache = new WeakMap<EditorClip, ArrangementNoteSpanCacheEntry>();

/** Memoizes the shared-projector result across playhead-driven repaints. */
function cachedArrangementMidiNoteSpans(source: EditorClip): ClipNoteSpan[] {
  const hit = arrangementNoteSpanCache.get(source);
  if (
    hit &&
    hit.sourceNotes === source.notes &&
    hit.startPpq === source.startPpq &&
    hit.lengthPpq === source.lengthPpq &&
    hit.sourceOffsetPpq === source.sourceOffsetPpq &&
    hit.loopEnabled === source.loopEnabled &&
    hit.loopLengthPpq === source.loopLengthPpq
  ) {
    return hit.spans;
  }
  const spans = arrangementMidiNoteSpans(source);
  arrangementNoteSpanCache.set(source, {
    sourceNotes: source.notes,
    startPpq: source.startPpq,
    lengthPpq: source.lengthPpq,
    sourceOffsetPpq: source.sourceOffsetPpq,
    loopEnabled: source.loopEnabled,
    loopLengthPpq: source.loopLengthPpq,
    spans,
  });
  return spans;
}

/** Minimum clip width in px before the name label is drawn. */
export const MIN_NAME_WIDTH_PX = 28;

/** Height of the name strip inside a clip body. */
export const NAME_STRIP_PX = 13;

/** Clip geometry as the drag preview and store mirror both provide it. */
export interface ClipGeometry {
  /** Id of the owning track. */
  trackId: number;
  /** Clip start in PPQ. */
  startPpq: number;
  /** Clip length in PPQ. */
  lengthPpq: number;
}

/** Shared state the clip drawing helpers read from the canvas. */
export interface ClipRenderContext {
  /** Timeline viewport. */
  range: TimelineRange;
  /** Tracks in lane order. */
  tracks: EditorTrack[];
  /** Lane index by track id (color and lane resolution). */
  trackIndexById: Map<number, number>;
  /** Height of one track lane in px. */
  laneHeight: number;
  /** Resolves the viewport y of a row's top edge. */
  laneTop: (index: number) => number;
  /** Bar length in PPQ (density bucket size). */
  barPpq: number;
  /** Shared tempo map mapping audio asset time onto absolute PPQ. */
  tempoMap: NormalizedTempoMap;
  /** Clip gesture state (fade preview source). */
  interactions: ClipInteractions;
  /** Schedules a base-layer repaint when an audio asset settles. */
  scheduleBase: () => void;
  /** Color tokens. */
  colors: ArrangementColors;
}

/**
 * Draws one clip body (fill, content, name, border) at the given geometry.
 *
 * @param ctx - Target 2D context.
 * @param source - Clip whose content (notes/asset) is rendered.
 * @param geometry - Clip extent to draw at (preview overrides the source).
 * @param selected - Whether to draw the selection fill and border.
 * @param context - Shared rendering state.
 */
export function drawClip(
  ctx: CanvasRenderingContext2D,
  source: EditorClip,
  geometry: ClipGeometry,
  selected: boolean,
  context: ClipRenderContext,
): void {
  const { range, tracks, trackIndexById, laneHeight, laneTop, barPpq, colors } = context;
  const laneIndex = trackIndexById.get(geometry.trackId);
  if (laneIndex === undefined) return;
  const track = tracks[laneIndex];
  const x = range.ppqToX(geometry.startPpq);
  const wPx = Math.max(2, geometry.lengthPpq * range.pxPerPpq - 1);
  if (x + wPx < 0 || x > range.widthPx) return;
  const y = laneTop(laneIndex) + 2;
  const hPx = laneHeight - 5;
  if (y + hPx < RULER_HEIGHT_PX || y > range.heightPx) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, RULER_HEIGHT_PX, range.widthPx, range.heightPx - RULER_HEIGHT_PX);
  ctx.clip();

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
    drawAudioWaveform(ctx, source, track.color, x, wPx, contentTop, contentH, context);
  } else if (contentH > 2 && source.notes.length > 0) {
    const noteSpans = cachedArrangementMidiNoteSpans(source);
    if (clipContentMode(range.pxPerPpq) === 'mini-notes') {
      ctx.fillStyle = colorWithAlpha(track.color, 0.95);
      for (const rect of cachedMiniNoteRects(noteSpans, 0, source.lengthPpq)) {
        ctx.fillRect(
          x + rect.u * wPx,
          contentTop + rect.v * contentH,
          Math.max(1, rect.uWidth * wPx),
          Math.max(1.5, rect.vHeight * contentH),
        );
      }
    } else {
      const buckets = cachedDensityBuckets(noteSpans, 0, source.lengthPpq, barPpq);
      const bucketW = barPpq * range.pxPerPpq;
      for (let i = 0; i < buckets.length; i++) {
        if (buckets[i] <= 0) continue;
        ctx.fillStyle = colorWithAlpha(track.color, 0.12 + 0.5 * buckets[i]);
        const bx = x + i * bucketW;
        ctx.fillRect(bx, contentTop, Math.min(bucketW, x + wPx - bx), contentH);
      }
    }
  }
  if (isAudioClip(source)) {
    drawAudioFades(ctx, source, x, y, wPx, hPx, context);
  }
  if (hasNameStrip) {
    ctx.fillStyle = colors.clipName;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(source.name, Math.max(x, 0) + 5, y + 10);
  }
  ctx.restore();

  ctx.lineWidth = selected ? 1.5 : 1;
  ctx.strokeStyle = selected ? colors.clipSelectedBorder : colors.clipBorder;
  strokeRoundRect(ctx, x + 0.5, y + 0.5, wPx - 1, hPx - 1, 3);
  ctx.restore();
}

/**
 * Draws an audio clip's min/max waveform from the cached peak envelope of its
 * asset, picking the pyramid level from the horizontal zoom. While the asset
 * is still loading a placeholder centerline is drawn and a repaint is
 * scheduled for when the load settles.
 *
 * @param ctx - Target 2D context.
 * @param source - Audio clip being rendered.
 * @param color - Track color.
 * @param x - Clip left edge in viewport px.
 * @param wPx - Clip width in px.
 * @param contentTop - Top of the content area in viewport px.
 * @param contentH - Height of the content area in px.
 * @param context - Shared rendering state.
 */
export function drawAudioWaveform(
  ctx: CanvasRenderingContext2D,
  source: EditorClip,
  color: string,
  x: number,
  wPx: number,
  contentTop: number,
  contentH: number,
  context: ClipRenderContext,
): void {
  const { range, tempoMap, scheduleBase } = context;
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
  const meta = asset.meta;
  const pxPerSecond = range.pxPerPpq * (tempoAtPpq(tempoMap, source.startPpq) / 60);
  const bucketCount = peaksBucketCount(
    meta.numFrames,
    meta.sampleRate,
    peaksBucketsPerSecond(pxPerSecond),
  );
  const peaks = audioAssetMergedPeaks(source.assetId, asset, bucketCount);
  const window = audioWindowFractions(
    source.sourceOffsetPpq,
    source.lengthPpq,
    tempoMap,
    meta.numFrames,
    meta.sampleRate,
    source.startPpq - source.sourceOffsetPpq,
  );
  // Map only the on-screen slice of the clip window to pixel columns.
  const span = window.endFrac - window.startFrac;
  const columnCount = Math.max(1, Math.round(visibleRight - visibleLeft));
  const columns = source.warp?.enabled
    ? warpedWaveformColumns(
        peaks,
        source,
        ((visibleLeft - x) / wPx) * source.lengthPpq,
        ((visibleRight - x) / wPx) * source.lengthPpq,
        columnCount,
        meta.numFrames,
        meta.sampleRate,
      )
    : waveformColumns(
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

/**
 * Draws the fade ramps, shaded corners and top fade handles of an audio clip.
 *
 * @param ctx - Target 2D context.
 * @param source - Audio clip being rendered.
 * @param x - Clip left edge in viewport px.
 * @param y - Clip top edge in viewport px.
 * @param wPx - Clip width in px.
 * @param hPx - Clip height in px.
 * @param context - Shared rendering state.
 */
export function drawAudioFades(
  ctx: CanvasRenderingContext2D,
  source: EditorClip,
  x: number,
  y: number,
  wPx: number,
  hPx: number,
  context: ClipRenderContext,
): void {
  const { range, interactions, colors } = context;
  const preview = interactions.previewFades.value;
  const fades =
    preview && preview.clipId === source.id
      ? preview
      : { fadeInPpq: source.fadeInPpq ?? 0, fadeOutPpq: source.fadeOutPpq ?? 0 };
  const pxPerPpq = range.pxPerPpq;
  const bottom = y + hPx;
  const fadeInPx = Math.min(wPx, fades.fadeInPpq * pxPerPpq);
  const fadeOutPx = Math.min(wPx, fades.fadeOutPpq * pxPerPpq);
  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.fadeRamp;
  if (fadeInPx > 0) {
    ctx.fillStyle = colors.fadeOverlay;
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
    ctx.fillStyle = colors.fadeOverlay;
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
    drawFadeHandle(ctx, xs.inX, y, colors);
    drawFadeHandle(ctx, xs.outX, y, colors);
  }
}

/**
 * Draws one downward-pointing fade handle triangle at the clip top edge.
 *
 * @param ctx - Target 2D context.
 * @param handleX - Handle center x in viewport px.
 * @param top - Clip top edge in viewport px.
 * @param colors - Color tokens.
 */
function drawFadeHandle(
  ctx: CanvasRenderingContext2D,
  handleX: number,
  top: number,
  colors: ArrangementColors,
): void {
  const half = FADE_HANDLE_SIZE_PX / 2;
  ctx.fillStyle = colors.fadeHandle;
  ctx.beginPath();
  ctx.moveTo(handleX - half, top + 1);
  ctx.lineTo(handleX + half, top + 1);
  ctx.lineTo(handleX, top + 1 + FADE_HANDLE_SIZE_PX);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draws all clips, applying the in-flight drag preview when present.
 *
 * @param ctx - Target 2D context.
 * @param clips - Clips to render (store mirror order).
 * @param activeClipId - Id of the selected clip.
 * @param context - Shared rendering state.
 */
export function drawClips(
  ctx: CanvasRenderingContext2D,
  clips: EditorClip[],
  activeClipId: number,
  context: ClipRenderContext,
): void {
  const { interactions, colors } = context;
  const preview = interactions.previewClip.value;
  for (const clip of clips) {
    let geometry: ClipGeometry = clip;
    let selected = clip.id === activeClipId;
    if (preview && !preview.copy && preview.clipId === clip.id) {
      geometry = preview;
      selected = true;
    }
    drawClip(ctx, clip, geometry, selected, context);
  }
  if (preview?.copy) {
    const source = clips.find((clip) => clip.id === preview.clipId);
    if (source) drawClip(ctx, source, preview, true, context);
  }
  const draft = interactions.previewDraft.value;
  if (draft) drawDraft(ctx, draft, context, colors);
}

/**
 * Draws the draw-tool draft outline (a dashed accent rectangle).
 *
 * @param ctx - Target 2D context.
 * @param draft - Draft clip extent.
 * @param context - Shared rendering state.
 * @param colors - Color tokens.
 */
function drawDraft(
  ctx: CanvasRenderingContext2D,
  draft: ClipGeometry,
  context: ClipRenderContext,
  colors: ArrangementColors,
): void {
  const { range, trackIndexById, laneHeight, laneTop } = context;
  const laneIndex = trackIndexById.get(draft.trackId);
  if (laneIndex === undefined) return;
  const x = range.ppqToX(draft.startPpq);
  const wPx = Math.max(2, draft.lengthPpq * range.pxPerPpq - 1);
  if (x + wPx < 0 || x > range.widthPx) return;
  const y = laneTop(laneIndex) + 2;
  const hPx = laneHeight - 5;
  if (y + hPx < RULER_HEIGHT_PX || y > range.heightPx) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, RULER_HEIGHT_PX, range.widthPx, range.heightPx - RULER_HEIGHT_PX);
  ctx.clip();
  ctx.fillStyle = colors.draftFill;
  fillRoundRect(ctx, x, y, wPx, hPx, 3);
  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.draftStroke;
  strokeRoundRect(ctx, x + 0.5, y + 0.5, wPx - 1, hPx - 1, 3);
  ctx.restore();
}
