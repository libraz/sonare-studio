/**
 * Canvas rendering and viewport navigation for the sample editor. Owns the
 * (non-reactive) {@link SampleViewport} instance, the waveform canvas, the
 * draw scheduling, the ResizeObserver lifecycle and the wheel zoom/scroll.
 *
 * Redraws are scheduled explicitly after viewport changes and run on a single
 * animation frame; reactive inputs (selection, asset, onsets) also trigger a
 * scheduled redraw through an internal watcher.
 */

import { markRaw, onBeforeUnmount, onMounted, type Ref, ref, watch } from 'vue';
import { getCanvasContext } from '@/components/piano-roll/theme';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { CANVAS_FONT_SIZE_PX, canvasFont, colorWithAlpha, TOKENS } from '@/ui/theme/tokens';
import { type ChannelPeaks, computePeaks } from '@/ui/waveform/peaks';
import type { DetectedNote } from './onsets';
import { snapFrameToOnsets } from './onsets';
import type { SampleRange } from './ops';
import type { SelectionDraft } from './selection';
import { SampleViewport } from './viewport';

/** Height of one channel lane in CSS px. */
export const LANE_HEIGHT_PX = 96;
/** Wheel-zoom sensitivity (factor exponent per wheel delta unit). */
const WHEEL_ZOOM_SENSITIVITY = 0.01;
/** Pointer distance (CSS px) within which a selection edge snaps to an onset. */
const ONSET_SNAP_PX = 6;
/** Visible waveform snapshots retained while scrubbing or redrawing overlays. */
export const MAX_VISIBLE_PEAK_CACHE_ENTRIES = 24;

/**
 * Returns the number of real sample buckets needed for one visible window.
 *
 * At high zoom there can be fewer source frames than display columns. Keeping
 * the peak resolution at the frame count avoids asking the peak scanner for
 * synthetic empty buckets that would otherwise render as a false zero line.
 */
export function visiblePeakBucketCount(widthPx: number, frameCount: number): number {
  if (!(widthPx > 0) || !(frameCount > 0)) return 0;
  return Math.min(Math.floor(widthPx), Math.floor(frameCount));
}

/** Maps a display column to one of the real buckets in a rendered peak set. */
export function peakBucketForDisplayColumn(
  columnPx: number,
  widthPx: number,
  bucketCount: number,
): number {
  if (!(widthPx > 0) || !(bucketCount > 0)) return 0;
  const column = Math.min(Math.max(0, Math.floor(columnPx)), Math.ceil(widthPx) - 1);
  return Math.min(bucketCount - 1, Math.floor((column * bucketCount) / widthPx));
}

/** Canvas color tokens, derived from the dark palette mirror in tokens.ts. */
const COLORS = {
  background: TOKENS.surface2,
  waveform: TOKENS.accent,
  centerLine: colorWithAlpha(TOKENS.border, 0.7),
  laneSeparator: colorWithAlpha(TOKENS.border, 0.6),
  selectionFill: colorWithAlpha(TOKENS.accent, 0.16),
  selectionEdge: colorWithAlpha(TOKENS.accent, 0.85),
  onsetMarker: colorWithAlpha(TOKENS.warning, 0.7),
  noteLabel: colorWithAlpha(TOKENS.warning, 0.95),
} as const;

/** Gap a note label needs from the previous one before it is drawn, in CSS px. */
const NOTE_LABEL_MIN_GAP_PX = 26;

/** Options for {@link useSampleViewport}. */
export interface UseSampleViewportOptions {
  /** Currently loaded asset ref (null when none). */
  asset: Ref<LoadedAudioAsset | null>;
  /** Selection draft ref (drives the selection overlay). */
  selection: Ref<SelectionDraft | null>;
  /** Detected onset marker frames ref. */
  onsetFrames: Ref<number[]>;
  /** Detected note regions ref; each is labelled with its pitch. */
  noteRegions: Ref<ReadonlyArray<DetectedNote>>;
  /** Formats a (fractional) MIDI number for a note label. */
  formatNote: (midi: number) => string;
  /** Normalized selection range getter (drives the selection fill/edges). */
  selRange: () => SampleRange | null;
}

/** Small LRU cache for an exact visible waveform window. */
export class VisiblePeaksCache {
  private readonly entries = new Map<string, ChannelPeaks[]>();

  getOrCompute(key: string, compute: () => ChannelPeaks[]): ChannelPeaks[] {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const peaks = compute();
    this.entries.set(key, peaks);
    if (this.entries.size > MAX_VISIBLE_PEAK_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return peaks;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Viewport rendering/navigation surface returned by {@link useSampleViewport}. */
export function useSampleViewport(options: UseSampleViewportOptions) {
  const { asset, selection, onsetFrames, noteRegions, formatNote, selRange } = options;

  const wrapRef = ref<HTMLDivElement | null>(null);
  const canvasRef = ref<HTMLCanvasElement | null>(null);

  /** Non-reactive: redraws are scheduled explicitly after viewport changes. */
  let viewport: SampleViewport | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let drawQueued = false;
  let drawFrame: number | null = null;
  const visiblePeaks = new VisiblePeaksCache();
  /** Backing-store size last applied to the canvas; resizing clears and reallocates it. */
  let sizedKey = '';
  let sizedCanvas: HTMLCanvasElement | null = null;
  /** Offscreen waveform/onset/note layer, reused while only the selection changes. */
  let baseLayer: HTMLCanvasElement | null = null;
  let baseLayerKey = '';
  /** Bumped when asset, onsets or notes change so the cached layer is rebuilt. */
  let baseVersion = 0;

  function scheduleDraw(): void {
    if (drawQueued) return;
    drawQueued = true;
    drawFrame = requestAnimationFrame(() => {
      drawFrame = null;
      drawQueued = false;
      draw();
    });
  }

  function draw(): void {
    const canvas = canvasRef.value;
    const view = viewport;
    if (!canvas || !view) return;
    const loaded = asset.value;
    const widthPx = Math.max(1, Math.round(view.widthPx));
    const lanes = Math.max(1, loaded?.channels.length ?? 1);
    const heightPx = lanes * LANE_HEIGHT_PX;
    canvas.style.height = `${heightPx}px`;
    const dpr = globalThis.devicePixelRatio || 1;
    const nextSizedKey = `${widthPx}x${heightPx}@${dpr}`;
    if (sizedCanvas !== canvas || sizedKey !== nextSizedKey) {
      canvas.width = Math.max(1, Math.round(widthPx * dpr));
      canvas.height = Math.max(1, Math.round(heightPx * dpr));
      sizedCanvas = canvas;
      sizedKey = nextSizedKey;
    }
    const ctx = getCanvasContext(canvas);
    if (!ctx) return;

    const baseKey = `${nextSizedKey}:${baseVersion}:${view.startFrame}:${view.endFrame}`;
    if (!baseLayer || baseLayerKey !== baseKey) {
      baseLayer ??= document.createElement('canvas');
      baseLayer.width = canvas.width;
      baseLayer.height = canvas.height;
      const layerCtx = getCanvasContext(baseLayer);
      if (!layerCtx) return;
      drawBase(layerCtx, view, loaded, widthPx, heightPx);
      baseLayerKey = baseKey;
    }
    ctx.drawImage(baseLayer, 0, 0, widthPx, heightPx);

    const range = selRange();
    if (range) {
      const x0 = Math.max(0, view.frameToX(range.startFrame));
      const x1 = Math.min(widthPx, view.frameToX(range.endFrame));
      if (x1 > x0) {
        ctx.fillStyle = COLORS.selectionFill;
        ctx.fillRect(x0, 0, x1 - x0, heightPx);
        ctx.fillStyle = COLORS.selectionEdge;
        ctx.fillRect(Math.floor(x0), 0, 1, heightPx);
        ctx.fillRect(Math.floor(x1) - 1, 0, 1, heightPx);
      }
    }
  }

  /** Paints background, waveform, onset markers and note labels (everything but the selection). */
  function drawBase(
    ctx: CanvasRenderingContext2D,
    view: SampleViewport,
    loaded: LoadedAudioAsset | null,
    widthPx: number,
    heightPx: number,
  ): void {
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, widthPx, heightPx);
    if (!loaded || loaded.meta.numFrames === 0) return;

    const startFrame = Math.max(0, Math.floor(view.startFrame));
    const endFrame = Math.min(loaded.meta.numFrames, Math.ceil(view.endFrame));
    if (endFrame > startFrame) {
      const bucketCount = visiblePeakBucketCount(widthPx, endFrame - startFrame);
      const key = `${loaded.meta.id}:${startFrame}:${endFrame}:${bucketCount}`;
      const peaks = visiblePeaks.getOrCompute(key, () => {
        const windows = loaded.channels.map((channel) => channel.subarray(startFrame, endFrame));
        return computePeaks(windows, bucketCount);
      });
      for (let c = 0; c < peaks.length; c++) {
        const laneTop = c * LANE_HEIGHT_PX;
        const mid = laneTop + LANE_HEIGHT_PX / 2;
        const amp = (LANE_HEIGHT_PX / 2) * 0.9;
        if (c > 0) {
          ctx.fillStyle = COLORS.laneSeparator;
          ctx.fillRect(0, laneTop, widthPx, 1);
        }
        ctx.fillStyle = COLORS.centerLine;
        ctx.fillRect(0, mid, widthPx, 1);
        ctx.fillStyle = COLORS.waveform;
        const { min, max } = peaks[c];
        for (let x = 0; x < widthPx; x++) {
          const bucket = peakBucketForDisplayColumn(x, widthPx, bucketCount);
          const hi = Math.min(1, Math.max(-1, max[bucket]));
          const lo = Math.min(1, Math.max(-1, min[bucket]));
          const y = mid - hi * amp;
          ctx.fillRect(x, y, 1, Math.max(1, (hi - lo) * amp));
        }
      }
    }

    if (onsetFrames.value.length > 0) {
      ctx.fillStyle = COLORS.onsetMarker;
      for (const frame of onsetFrames.value) {
        const x = view.frameToX(frame);
        if (x < 0 || x > widthPx) continue;
        ctx.fillRect(Math.floor(x), 0, 1, heightPx);
      }
    }

    // A detected note carries its pitch, so name it at its start. Labels are
    // skipped rather than overlapped when the notes are too close to read.
    if (noteRegions.value.length > 0) {
      ctx.fillStyle = COLORS.noteLabel;
      ctx.font = canvasFont(CANVAS_FONT_SIZE_PX.meta);
      ctx.textBaseline = 'top';
      let lastLabelX = Number.NEGATIVE_INFINITY;
      for (const note of noteRegions.value) {
        const x = view.frameToX(note.startFrame);
        if (x < 0 || x > widthPx) continue;
        if (x - lastLabelX < NOTE_LABEL_MIN_GAP_PX) continue;
        lastLabelX = x;
        ctx.fillText(formatNote(note.midi), Math.floor(x) + 2, 2);
      }
    }
  }

  watch([selection, asset, onsetFrames, noteRegions], scheduleDraw);
  watch([asset, onsetFrames, noteRegions], () => {
    baseVersion += 1;
  });
  watch(asset, () => visiblePeaks.clear());

  /** Current viewport instance (null before the first load). */
  function getViewport(): SampleViewport | null {
    return viewport;
  }

  /**
   * Builds or updates the viewport for a newly loaded buffer: reuses the
   * existing instance (preserving zoom/scroll) when its width still matches,
   * otherwise creates a fresh one fitted to the wrapper width.
   */
  function syncViewportToFrames(totalFrames: number): void {
    const widthPx = wrapRef.value?.clientWidth || 800;
    if (viewport && viewport.widthPx === widthPx) {
      viewport.setTotalFrames(totalFrames);
    } else {
      viewport = markRaw(new SampleViewport(totalFrames, widthPx));
    }
  }

  /** Drops the viewport so the next load fits a fresh buffer (asset change). */
  function resetViewport(): void {
    viewport = null;
  }

  function localX(event: PointerEvent | WheelEvent): number {
    const rect = wrapRef.value?.getBoundingClientRect();
    return event.clientX - (rect?.left ?? 0);
  }

  /** Maps a pointer x to a frame, snapping to a nearby onset marker if one exists. */
  function frameAtPointer(view: SampleViewport, x: number): number {
    const frame = view.xToFrame(x);
    if (onsetFrames.value.length === 0) return frame;
    return snapFrameToOnsets(frame, onsetFrames.value, ONSET_SNAP_PX * view.framesPerPx);
  }

  function onWheel(event: WheelEvent): void {
    const view = viewport;
    if (!view) return;
    if (event.metaKey || event.ctrlKey) {
      view.zoomAt(localX(event), Math.exp(event.deltaY * WHEEL_ZOOM_SENSITIVITY));
    } else {
      view.scrollByPx(event.deltaX !== 0 ? event.deltaX : event.deltaY);
    }
    scheduleDraw();
  }

  function zoomToFit(): void {
    viewport?.zoomToFit();
    scheduleDraw();
  }

  onMounted(() => {
    if (typeof ResizeObserver === 'function' && wrapRef.value) {
      resizeObserver = new ResizeObserver(() => {
        const widthPx = wrapRef.value?.clientWidth;
        if (widthPx && viewport) {
          viewport.resize(widthPx);
          scheduleDraw();
        }
      });
      resizeObserver.observe(wrapRef.value);
    }
  });

  onBeforeUnmount(() => {
    if (drawFrame !== null) {
      cancelAnimationFrame(drawFrame);
      drawFrame = null;
      drawQueued = false;
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    visiblePeaks.clear();
    baseLayer = null;
  });

  return {
    wrapRef,
    canvasRef,
    scheduleDraw,
    getViewport,
    syncViewportToFrames,
    resetViewport,
    localX,
    frameAtPointer,
    onWheel,
    zoomToFit,
  };
}
