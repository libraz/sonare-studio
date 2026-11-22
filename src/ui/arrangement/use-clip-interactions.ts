/**
 * Pointer interaction logic for arrangement clips: click selection, drag move
 * (horizontal snap + vertical lane change), edge trims (optionally clamped to
 * source bounds), audio-clip fade-handle drags, alt/option-drag duplication
 * and double-click clip creation on empty lanes.
 *
 * Framework-light on purpose: only Vue refs for observable state, all
 * mutations through an injected command set, so the gesture logic is
 * unit-testable without mounting components.
 */

import { type Ref, ref } from 'vue';
import { clamp } from '@/lib/math';
import { type ClipSplitBlockReason, clipSplitBlockReason } from '@/project/clip-split';
import { DRAG_THRESHOLD_PX } from '@/ui/canvas/drag-threshold';
import { snapPpqToStep } from '@/ui/canvas/timeline-range';
import type { EditorToolId } from '@/ui/editor/tools';
import {
  clampFadePpq,
  clipRenderTopPx,
  clipRenderWidthPx,
  type FadeEdge,
  fadeHandleRect,
  hitTestFadeHandles,
} from './audio-fades';
import {
  type ArrangeClipRect,
  type ClipHitZone,
  type ClipLaneView,
  type ClipPoint,
  hitTestClip,
} from './clip-hit';

/** Smallest clip length a trim can produce, in PPQ (a sixteenth note). */
export const DEFAULT_MIN_CLIP_LENGTH_PPQ = 0.25;

/** Modifier-key state captured from the originating pointer event. */
export interface ClipModifiers {
  /** Alt/Option: drag duplicates the clip instead of moving it. */
  alt?: boolean;
  /** Cmd (or Ctrl): bypasses grid snapping while held. */
  meta?: boolean;
  /** Shift: extend the arrangement selection. */
  shift?: boolean;
}

/** A clip's arrangement extent as the gestures need it. */
export interface ArrangeClip {
  /** Stable clip id. */
  id: number;
  /** Id of the owning track. */
  trackId: number;
  /** Clip start in PPQ. */
  startPpq: number;
  /** Clip length in PPQ (> 0). */
  lengthPpq: number;
  /** Clip content kind; absent = 'midi'. Fade handles exist on audio clips. */
  kind?: 'midi' | 'audio';
  /** True when native split is unavailable until the clip loop is disabled. */
  loopEnabled?: boolean;
  /** Fade-in length in PPQ (audio clips; absent = 0). */
  fadeInPpq?: number;
  /** Fade-out length in PPQ (audio clips; absent = 0). */
  fadeOutPpq?: number;
}

/** View contract for the gestures; adds the lane count to the hit-test view. */
export interface ClipInteractionsView extends ClipLaneView {
  /** Number of track lanes currently shown. */
  readonly laneCount: number;
}

/** A bar window used for double-click clip creation. */
export interface ClipBarRange {
  startPpq: number;
  lengthPpq: number;
}

/** Command surface the gestures call into (src/project/commands.ts in the app). */
export interface ClipInteractionCommands {
  /** Makes a clip the active (selected) clip. */
  selectClip(clipId: number): void;
  selectClips?(clipIds: readonly number[], activeClipId?: number): void;
  /** Clears the active clip after a select-tool click on an empty lane. */
  clearClipSelection?(trackId?: number): void;
  moveClip(clipId: number, newStartPpq: number, newTrackId?: number): void;
  /** Moves several selected clips together as one undoable edit. */
  moveClips?(moves: readonly { clipId: number; newStartPpq: number; newTrackId?: number }[]): void;
  trimClip(clipId: number, newStartPpq: number, newLengthPpq: number): void;
  duplicateClip(clipId: number, newStartPpq: number): number;
  /** Creates an empty clip and returns its id (null = creation not allowed). */
  createClip(trackId: number, startPpq: number, lengthPpq: number): number | null;
  /** Sets both fade lengths of an audio clip (0 clears). Enables fade handles. */
  setClipFades?(clipId: number, fadeInPpq: number, fadeOutPpq: number): void;
  /** Deletes a clip (used by the erase tool; absent = erase is a no-op). */
  deleteClip?(clipId: number): void;
  /** Splits a clip at a timeline position (used by the split tool). */
  splitClip?(clipId: number, splitPpq: number): number;
}

/** Timeline bounds trims of a clip must stay inside (see getSourceBounds). */
export interface ClipSourceBounds {
  /** Lowest allowed clip start in PPQ. */
  minStartPpq: number;
  /** Highest allowed clip end in PPQ. */
  maxEndPpq: number;
}

/** Configuration for {@link useClipInteractions}. */
export interface UseClipInteractionsOptions {
  /** Coordinate mapping for the arrangement viewport. */
  view: ClipInteractionsView;
  /** Returns the current clip list (draw order, last = topmost). */
  getClips(): ReadonlyArray<ArrangeClip>;
  getSelectedClipIds?(): ReadonlySet<number>;
  /** Returns track ids in lane order (index = lane index). */
  getTrackIds(): ReadonlyArray<number>;
  /** Returns true when this clip may be moved to the target track. */
  canMoveClipToTrack?(clipId: number, trackId: number): boolean;
  /** Returns false when a clip is read-only (for example on a frozen track). */
  canEditClip?(clipId: number): boolean;
  /** Returns false when new clips may not be created on a track. */
  canEditTrack?(trackId: number): boolean;
  /** Returns the current snap grid step in PPQ (<= 0 disables snapping). */
  getGridPpq(): number;
  /** Optionally resolves a PPQ position on a meter-aware grid. */
  snapPpq?(ppq: number): number;
  /** Returns the bar containing a PPQ position (for double-click creation). */
  getBarRange(ppq: number): ClipBarRange;
  /** Returns the active editor tool (absent = always the select tool). */
  getTool?(): EditorToolId;
  /** Reports why the split tool could not edit the hit clip. */
  onSplitBlocked?(clipId: number, reason: ClipSplitBlockReason): void;
  /**
   * Reports a gesture whose command refused the edit; without it the error
   * propagates out of the pointer handler.
   */
  onCommandError?(cause: unknown): void;
  /** Mutation commands invoked when gestures commit. */
  commands: ClipInteractionCommands;
  /**
   * Returns the source bounds trims of a clip must respect (e.g. an audio
   * clip's backing asset extent), or null for unbounded trimming.
   */
  getSourceBounds?(clipId: number): ClipSourceBounds | null;
  /** Drag start threshold in px. Default {@link DRAG_THRESHOLD_PX}. */
  dragThresholdPx?: number;
  /** Px distance from a clip edge treated as a trim handle. */
  trimTolerancePx?: number;
  /** Minimum clip length kept by trims, in PPQ. Default {@link DEFAULT_MIN_CLIP_LENGTH_PPQ}. */
  minLengthPpq?: number;
}

/** Geometry of the in-flight drag, for rendering only. */
export interface ClipDragPreview {
  /** Id of the source clip being dragged. */
  clipId: number;
  /** Current target track id. */
  trackId: number;
  /** Current start in PPQ. */
  startPpq: number;
  /** Current length in PPQ. */
  lengthPpq: number;
  /** True for an alt-drag duplicate (the source clip stays in place). */
  copy: boolean;
}

/** Resolved fade lengths of an in-flight fade drag, for rendering only. */
export interface ClipFadePreview {
  /** Id of the clip whose fades are being dragged. */
  clipId: number;
  /** Current fade-in length in PPQ (0 = none). */
  fadeInPpq: number;
  /** Current fade-out length in PPQ (0 = none). */
  fadeOutPpq: number;
}

/** Geometry of an in-flight draw-tool clip, for rendering the draft outline. */
export interface ClipDraftPreview {
  /** Target track id of the draft. */
  trackId: number;
  /** Draft start in PPQ. */
  startPpq: number;
  /** Draft length in PPQ. */
  lengthPpq: number;
}

/** Pixel rectangle of an in-flight empty-area selection drag. */
export interface ClipMarqueePreview {
  /** Left edge in canvas-local pixels. */
  left: number;
  /** Top edge in canvas-local pixels. */
  top: number;
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
}

/** CSS cursor reflecting what a pointer press at the hovered point would do. */
export type ClipCursor = 'default' | 'pointer' | 'move' | 'copy' | 'ew-resize' | 'crosshair';

/** Reactive state and event handlers returned by {@link useClipInteractions}. */
export interface ClipInteractions {
  /** In-flight drag geometry, or null when no drag is running. */
  previewClip: Ref<ClipDragPreview | null>;
  /** In-flight fade-drag values, or null when no fade drag is running. */
  previewFades: Ref<ClipFadePreview | null>;
  /** In-flight draw-tool draft outline, or null when no draw is running. */
  previewDraft: Ref<ClipDraftPreview | null>;
  /** In-flight empty-area selection rectangle, or null when not selecting. */
  previewMarquee: Ref<ClipMarqueePreview | null>;
  /** In-flight geometry for every clip in a grouped move. */
  previewClips: Ref<ClipDragPreview[]>;
  /** Cursor to show over the arrangement lanes. */
  cursor: Ref<ClipCursor>;
  /** Handles pointerdown on the lane area (point in local px). */
  onPointerDown(point: ClipPoint, modifiers?: ClipModifiers): void;
  /** Handles pointermove (hover feedback and drag updates). */
  onPointerMove(point: ClipPoint, modifiers?: ClipModifiers): void;
  /** Handles pointerup; commits the gesture through the commands. */
  onPointerUp(point: ClipPoint, modifiers?: ClipModifiers): void;
  /** Handles double-click; creates a one-bar clip on an empty lane. */
  onDoubleClick(point: ClipPoint, modifiers?: ClipModifiers): void;
  /** Returns the topmost clip id under a point, or null when none is hit. */
  hitClipAt(point: ClipPoint): number | null;
  /** Aborts any in-flight gesture without committing (e.g. pointercancel). */
  cancel(): void;
}

interface PendingGesture {
  kind: 'pending';
  start: ClipPoint;
  /** Musical pointer position captured before the viewport can scroll. */
  pointerStartPpq: number;
  clip: ArrangeClip;
  zone: ClipHitZone;
  duplicate: boolean;
  origins: ArrangeClip[];
}

interface MoveGesture {
  kind: 'move';
  start: ClipPoint;
  pointerStartPpq: number;
  origin: ArrangeClip;
  origins: ArrangeClip[];
  duplicate: boolean;
}

interface MarqueeGesture {
  kind: 'marquee';
  start: ClipPoint;
  /** Shift extends instead of replacing the existing selection. */
  additive: boolean;
  moved: boolean;
}

interface TrimGesture {
  kind: 'trim';
  edge: 'start' | 'end';
  start: ClipPoint;
  pointerStartPpq: number;
  origin: ArrangeClip;
}

interface FadeGesture {
  kind: 'fade';
  edge: FadeEdge;
  start: ClipPoint;
  pointerStartPpq: number;
  origin: ArrangeClip;
}

/** Draw-tool gesture: a new clip grows from its start to the pointer. */
interface DrawClipGesture {
  kind: 'draw-clip';
  start: ClipPoint;
  trackId: number;
  startPpq: number;
}

type Gesture =
  | { kind: 'none' }
  | PendingGesture
  | MoveGesture
  | TrimGesture
  | FadeGesture
  | MarqueeGesture
  | DrawClipGesture;

/**
 * Creates the clip interaction state machine for one arrangement surface.
 *
 * @param options - View mapping, state accessors and mutation commands.
 * @returns Reactive gesture state plus pointer handlers.
 */
export function useClipInteractions(options: UseClipInteractionsOptions): ClipInteractions {
  const { view, commands } = options;
  const threshold = options.dragThresholdPx ?? DRAG_THRESHOLD_PX;
  const minLength = options.minLengthPpq ?? DEFAULT_MIN_CLIP_LENGTH_PPQ;

  const previewClip = ref<ClipDragPreview | null>(null);
  const previewClips = ref<ClipDragPreview[]>([]);
  const previewFades = ref<ClipFadePreview | null>(null);
  const previewDraft = ref<ClipDraftPreview | null>(null);
  const previewMarquee = ref<ClipMarqueePreview | null>(null);
  const cursor = ref<ClipCursor>('default');

  let gesture: Gesture = { kind: 'none' };

  /** The active tool ('select' when no tool getter is wired). */
  function currentTool(): EditorToolId {
    return options.getTool?.() ?? 'select';
  }

  function snapPosition(ppq: number, step: number): number {
    return step > 0 ? (options.snapPpq?.(ppq) ?? snapPpqToStep(ppq, step)) : Math.max(0, ppq);
  }

  /**
   * Resolves horizontal movement from the PPQ recorded at pointerdown rather
   * than from the old screen x. A TimelineRange can scroll while a drag is in
   * progress (wheel, follow-playhead or autoscroll), so subtracting two
   * current xToPpq calls would incorrectly cancel that scroll distance.
   */
  function pointerDeltaPpq(pointerStartPpq: number, point: ClipPoint): number {
    return view.xToPpq(point.x) - pointerStartPpq;
  }

  /** Resolves the lane and track under a point (track id null when off-lane). */
  function laneAt(point: ClipPoint): { laneIndex: number; trackId: number | null } {
    const trackIds = options.getTrackIds();
    const laneIndex = view.laneIndexAtY(point.y);
    const trackId = laneIndex >= 0 && laneIndex < trackIds.length ? trackIds[laneIndex] : null;
    return { laneIndex, trackId };
  }

  /** Resolves the snapped start of a draw at the pointer x, on the same grid as its end. */
  function drawStartPpq(point: ClipPoint, modifiers: ClipModifiers): number {
    const ppq = view.xToPpq(point.x);
    return modifiers.meta === true ? Math.max(0, ppq) : snapPosition(ppq, options.getGridPpq());
  }

  /** Resolves the snapped length of an in-flight clip draw (>= one bar). */
  function drawClipLength(g: DrawClipGesture, point: ClipPoint, modifiers: ClipModifiers): number {
    const step = options.getGridPpq();
    const raw = view.xToPpq(point.x);
    const end = modifiers.meta === true ? raw : snapPosition(raw, step);
    const bar = options.getBarRange(g.startPpq).lengthPpq;
    return Math.max(bar, end - g.startPpq);
  }

  /** Deletes the clip under the pointer, if any (erase tool). */
  /** Runs a gesture's command, routing a refusal to {@link ClipInteractionOptions.onCommandError}. */
  function commit(run: () => void): void {
    try {
      run();
    } catch (cause) {
      if (!options.onCommandError) throw cause;
      options.onCommandError(cause);
    }
  }

  function eraseAt(point: ClipPoint): void {
    if (!commands.deleteClip) return;
    const hit = hitTestClip(toRects(), point, view, hitOptions());
    if (hit && options.canEditClip?.(hit.id) !== false) commands.deleteClip(hit.id);
  }

  /** Splits the clip under the pointer at the snapped pointer position. */
  function splitAt(point: ClipPoint, modifiers: ClipModifiers): void {
    if (!commands.splitClip) return;
    const hit = hitTestClip(toRects(), point, view, hitOptions());
    if (!hit) return;
    const clip = options.getClips().find((c) => c.id === hit.id);
    if (!clip || options.canEditClip?.(clip.id) === false) return;
    const step = options.getGridPpq();
    const raw = view.xToPpq(point.x);
    const splitPpq = modifiers.meta === true ? raw : snapPosition(raw, step);
    const blocked = clipSplitBlockReason(clip, splitPpq);
    if (blocked !== null) {
      options.onSplitBlocked?.(clip.id, blocked);
      return;
    }
    const rightId = commands.splitClip(clip.id, splitPpq);
    commands.selectClip(rightId);
  }

  function hitOptions(): { trimTolerancePx?: number } {
    return options.trimTolerancePx === undefined
      ? {}
      : { trimTolerancePx: options.trimTolerancePx };
  }

  // Lane lookup keyed on the track-id contents (getTrackIds may allocate per call).
  let laneCache: { ids: ReadonlyArray<number>; map: Map<number, number> } | null = null;

  function laneByTrack(): Map<number, number> {
    const ids = options.getTrackIds();
    const hit = laneCache;
    if (hit && hit.ids.length === ids.length && ids.every((id, i) => id === hit.ids[i])) {
      return hit.map;
    }
    const map = new Map(ids.map((id, index) => [id, index]));
    laneCache = { ids: [...ids], map };
    return map;
  }

  // Hit-test rectangles keyed on the clip array identity (edits replace the array).
  let rectsCache: {
    clips: ReadonlyArray<ArrangeClip>;
    lanes: Map<number, number>;
    rects: ArrangeClipRect[];
  } | null = null;

  /** Projects the clips into lane-indexed rectangles for the hit-test. */
  function toRects(): ArrangeClipRect[] {
    const lanes = laneByTrack();
    const clips = options.getClips();
    if (rectsCache && rectsCache.clips === clips && rectsCache.lanes === lanes) {
      return rectsCache.rects;
    }
    const rects: ArrangeClipRect[] = [];
    for (const clip of clips) {
      const laneIndex = lanes.get(clip.trackId);
      if (laneIndex === undefined) continue;
      rects.push({
        id: clip.id,
        laneIndex,
        startPpq: clip.startPpq,
        lengthPpq: clip.lengthPpq,
      });
    }
    rectsCache = { clips, lanes, rects };
    return rects;
  }

  /** Clips whose screen rectangle overlaps the given selection rectangle. */
  function marqueeClipIds(start: ClipPoint, end: ClipPoint): number[] {
    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const bottom = Math.max(start.y, end.y);
    const lanes = laneByTrack();
    return options
      .getClips()
      .filter((clip) => {
        const lane = lanes.get(clip.trackId);
        if (lane === undefined) return false;
        const clipLeft = view.ppqToX(clip.startPpq);
        const clipRight = view.ppqToX(clip.startPpq + clip.lengthPpq);
        const clipTop = view.laneTop(lane);
        const clipBottom = clipTop + view.laneHeight;
        return clipRight >= left && clipLeft <= right && clipBottom >= top && clipTop <= bottom;
      })
      .map((clip) => clip.id);
  }

  function marqueePreview(start: ClipPoint, end: ClipPoint): ClipMarqueePreview {
    return {
      left: Math.min(start.x, end.x),
      top: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
  }

  /** Snapshots the selected group only when the pressed clip belongs to it. */
  function moveOrigins(clip: ArrangeClip, duplicate: boolean): ArrangeClip[] {
    if (duplicate) return [{ ...clip }];
    const selected = options.getSelectedClipIds?.();
    if (!selected?.has(clip.id)) return [{ ...clip }];
    const origins = options
      .getClips()
      .filter((candidate) => selected.has(candidate.id))
      .map((candidate) => ({ ...candidate }));
    return origins.length > 0 ? origins : [{ ...clip }];
  }

  /**
   * Finds the topmost audio clip whose fade handle is under the point. Fade
   * handles only exist when the embedder provides the setClipFades command.
   */
  function fadeHandleHit(point: ClipPoint): { clip: ArrangeClip; edge: FadeEdge } | null {
    if (!commands.setClipFades) return null;
    const lanes = laneByTrack();
    const clips = options.getClips();
    for (let i = clips.length - 1; i >= 0; i--) {
      const clip = clips[i];
      if (clip.kind !== 'audio') continue;
      if (options.canEditClip?.(clip.id) === false) continue;
      const laneIndex = lanes.get(clip.trackId);
      if (laneIndex === undefined) continue;
      const left = view.ppqToX(clip.startPpq);
      const pxPerPpq =
        clip.lengthPpq > 0
          ? (view.ppqToX(clip.startPpq + clip.lengthPpq) - left) / clip.lengthPpq
          : 0;
      const rect = fadeHandleRect(
        left,
        clipRenderTopPx(view.laneTop(laneIndex)),
        clipRenderWidthPx(clip.lengthPpq, pxPerPpq),
      );
      const edge = hitTestFadeHandles(
        point,
        rect,
        clip.fadeInPpq ?? 0,
        clip.fadeOutPpq ?? 0,
        pxPerPpq,
      );
      if (edge) return { clip, edge };
    }
    return null;
  }

  /** Resolves the snapped, clamped fade lengths for the dragged fade handle. */
  function fadeTarget(
    g: FadeGesture,
    point: ClipPoint,
    modifiers: ClipModifiers,
  ): { fadeInPpq: number; fadeOutPpq: number } {
    const bypass = modifiers.meta === true;
    const step = options.getGridPpq();
    const delta = pointerDeltaPpq(g.pointerStartPpq, point);
    const length = g.origin.lengthPpq;
    const originIn = g.origin.fadeInPpq ?? 0;
    const originOut = g.origin.fadeOutPpq ?? 0;
    // The fade boundary (not the fade length) snaps to the grid.
    if (g.edge === 'in') {
      const boundary = g.origin.startPpq + originIn + delta;
      const snapped = bypass ? boundary : snapPosition(boundary, step);
      return {
        fadeInPpq: clampFadePpq(snapped - g.origin.startPpq, length, originOut),
        fadeOutPpq: originOut,
      };
    }
    const endPpq = g.origin.startPpq + length;
    const boundary = endPpq - originOut + delta;
    const snapped = bypass ? boundary : snapPosition(boundary, step);
    return {
      fadeInPpq: originIn,
      fadeOutPpq: clampFadePpq(endPpq - snapped, length, originIn),
    };
  }

  /** Resolves the snapped, clamped move target for the dragged clip. */
  function moveTarget(
    g: MoveGesture,
    point: ClipPoint,
    modifiers: ClipModifiers,
  ): { startPpq: number; trackId: number } {
    const rawDelta = pointerDeltaPpq(g.pointerStartPpq, point);
    const startPpq =
      modifiers.meta === true
        ? Math.max(0, g.origin.startPpq + rawDelta)
        : rawDelta === 0
          ? g.origin.startPpq
          : snapPosition(g.origin.startPpq + rawDelta, options.getGridPpq());
    // Duplicates stay on the source track; plain moves follow the pointer lane.
    if (g.duplicate) return { startPpq, trackId: g.origin.trackId };
    const trackIds = options.getTrackIds();
    const lane = clamp(view.laneIndexAtY(point.y), 0, Math.max(0, view.laneCount - 1));
    const candidateTrackId = trackIds[lane] ?? g.origin.trackId;
    const trackId =
      candidateTrackId === g.origin.trackId ||
      options.canMoveClipToTrack?.(g.origin.id, candidateTrackId) !== false
        ? candidateTrackId
        : g.origin.trackId;
    return { startPpq, trackId };
  }

  /** Resolves all destinations for a group, retaining relative timing and lane offsets. */
  function moveTargets(
    g: MoveGesture,
    point: ClipPoint,
    modifiers: ClipModifiers,
  ): { clipId: number; newStartPpq: number; newTrackId?: number }[] {
    const primary = moveTarget(g, point, modifiers);
    const horizontalDelta = primary.startPpq - g.origin.startPpq;
    const trackIds = options.getTrackIds();
    const lanes = laneByTrack();
    const sourceLane = lanes.get(g.origin.trackId) ?? -1;
    const targetLane = lanes.get(primary.trackId) ?? -1;
    const laneDelta = g.duplicate || sourceLane < 0 || targetLane < 0 ? 0 : targetLane - sourceLane;
    const canMoveAllLanes = g.origins.every((origin) => {
      const originLane = lanes.get(origin.trackId) ?? -1;
      const destination = trackIds[originLane + laneDelta];
      return (
        destination !== undefined &&
        (destination === origin.trackId ||
          options.canMoveClipToTrack?.(origin.id, destination) !== false)
      );
    });
    const effectiveLaneDelta = canMoveAllLanes ? laneDelta : 0;
    const minStart = Math.min(...g.origins.map((origin) => origin.startPpq));
    const effectiveHorizontalDelta = Math.max(-minStart, horizontalDelta);
    return g.origins.map((origin) => {
      const originLane = lanes.get(origin.trackId) ?? -1;
      const destination = trackIds[originLane + effectiveLaneDelta] ?? origin.trackId;
      return {
        clipId: origin.id,
        newStartPpq: origin.startPpq + effectiveHorizontalDelta,
        ...(destination === origin.trackId ? {} : { newTrackId: destination }),
      };
    });
  }

  /** Resolves the snapped, clamped trim extent for the dragged edge. */
  function trimTarget(
    g: TrimGesture,
    point: ClipPoint,
    modifiers: ClipModifiers,
  ): { startPpq: number; lengthPpq: number } {
    const bypass = modifiers.meta === true;
    const step = options.getGridPpq();
    const rawDelta = pointerDeltaPpq(g.pointerStartPpq, point);
    const originEnd = g.origin.startPpq + g.origin.lengthPpq;
    const bounds = options.getSourceBounds?.(g.origin.id) ?? null;
    if (g.edge === 'end') {
      let target = bypass ? originEnd + rawDelta : snapPosition(originEnd + rawDelta, step);
      if (bounds) target = Math.min(target, bounds.maxEndPpq);
      const end = bounds
        ? Math.min(bounds.maxEndPpq, Math.max(g.origin.startPpq + minLength, target))
        : Math.max(g.origin.startPpq + minLength, target);
      return { startPpq: g.origin.startPpq, lengthPpq: end - g.origin.startPpq };
    }
    const target = bypass
      ? Math.max(0, g.origin.startPpq + rawDelta)
      : snapPosition(g.origin.startPpq + rawDelta, step);
    const startPpq = bounds
      ? Math.max(bounds.minStartPpq, Math.min(originEnd - minLength, target))
      : Math.min(originEnd - minLength, target);
    return { startPpq, lengthPpq: originEnd - startPpq };
  }

  function onPointerDown(point: ClipPoint, modifiers: ClipModifiers = {}): void {
    const tool = currentTool();
    if (tool === 'erase') {
      commit(() => eraseAt(point));
      gesture = { kind: 'none' };
      return;
    }
    if (tool === 'split') {
      commit(() => splitAt(point, modifiers));
      gesture = { kind: 'none' };
      return;
    }
    if (tool === 'draw') {
      const { trackId } = laneAt(point);
      if (trackId === null || options.canEditTrack?.(trackId) === false) {
        gesture = { kind: 'none' };
        return;
      }
      gesture = {
        kind: 'draw-clip',
        start: point,
        trackId,
        startPpq: drawStartPpq(point, modifiers),
      };
      previewDraft.value = {
        trackId,
        startPpq: gesture.startPpq,
        lengthPpq: drawClipLength(gesture, point, modifiers),
      };
      cursor.value = 'crosshair';
      return;
    }
    const fadeHit = fadeHandleHit(point);
    if (fadeHit) {
      commands.selectClip(fadeHit.clip.id);
      cursor.value = 'ew-resize';
      gesture = {
        kind: 'fade',
        edge: fadeHit.edge,
        start: point,
        pointerStartPpq: view.xToPpq(point.x),
        origin: { ...fadeHit.clip },
      };
      return;
    }
    const hit = hitTestClip(toRects(), point, view, hitOptions());
    if (!hit) {
      gesture = { kind: 'marquee', start: point, additive: modifiers.shift === true, moved: false };
      return;
    }
    const clip = options.getClips().find((c) => c.id === hit.id);
    if (!clip) return;
    if (modifiers.shift === true && commands.selectClips) {
      const next = new Set(options.getSelectedClipIds?.() ?? []);
      if (next.has(clip.id)) next.delete(clip.id);
      else next.add(clip.id);
      commands.selectClips([...next], next.has(clip.id) ? clip.id : undefined);
      gesture = { kind: 'none' };
      return;
    }
    const alreadySelected = options.getSelectedClipIds?.().has(clip.id) === true;
    if (commands.selectClips) {
      const ids = alreadySelected ? [...(options.getSelectedClipIds?.() ?? [])] : [clip.id];
      commands.selectClips(ids, clip.id);
    } else commands.selectClip(clip.id);
    if (options.canEditClip?.(clip.id) === false) {
      gesture = { kind: 'none' };
      return;
    }
    gesture = {
      kind: 'pending',
      start: point,
      pointerStartPpq: view.xToPpq(point.x),
      clip: { ...clip },
      zone: hit.zone,
      duplicate: modifiers.alt === true,
      origins: moveOrigins(clip, modifiers.alt === true),
    };
  }

  /** Promotes a pending press into a drag gesture once the threshold is passed. */
  function promotePending(pending: PendingGesture): Gesture {
    if (pending.zone === 'body') {
      cursor.value = pending.duplicate ? 'copy' : 'move';
      return {
        kind: 'move',
        start: pending.start,
        pointerStartPpq: pending.pointerStartPpq,
        origin: pending.clip,
        origins: pending.origins,
        duplicate: pending.duplicate,
      };
    }
    cursor.value = 'ew-resize';
    return {
      kind: 'trim',
      edge: pending.zone === 'trim-start' ? 'start' : 'end',
      start: pending.start,
      pointerStartPpq: pending.pointerStartPpq,
      origin: pending.clip,
    };
  }

  function onPointerMove(point: ClipPoint, modifiers: ClipModifiers = {}): void {
    if (gesture.kind === 'none') {
      const tool = currentTool();
      if (tool !== 'select') {
        cursor.value = tool === 'erase' ? 'default' : 'crosshair';
        return;
      }
      if (fadeHandleHit(point)) {
        cursor.value = 'ew-resize';
        return;
      }
      const hit = hitTestClip(toRects(), point, view, hitOptions());
      cursor.value = hit ? (hit.zone === 'body' ? 'pointer' : 'ew-resize') : 'default';
      return;
    }
    if (gesture.kind === 'draw-clip') {
      previewDraft.value = {
        trackId: gesture.trackId,
        startPpq: gesture.startPpq,
        lengthPpq: drawClipLength(gesture, point, modifiers),
      };
      return;
    }
    if (gesture.kind === 'marquee') {
      if (Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) >= threshold) {
        gesture.moved = true;
        previewMarquee.value = marqueePreview(gesture.start, point);
        cursor.value = 'default';
      }
      return;
    }
    if (gesture.kind === 'fade') {
      const fades = fadeTarget(gesture, point, modifiers);
      previewFades.value = { clipId: gesture.origin.id, ...fades };
      return;
    }
    if (gesture.kind === 'pending') {
      if (Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) < threshold) return;
      gesture = promotePending(gesture);
    }
    if (gesture.kind === 'move') {
      const move = gesture;
      const targets = moveTargets(move, point, modifiers);
      // Targets are index-aligned with the group's origins.
      previewClips.value = targets.map((target, i) => {
        const origin = move.origins[i];
        return {
          clipId: target.clipId,
          trackId: target.newTrackId ?? origin.trackId,
          startPpq: target.newStartPpq,
          lengthPpq: origin.lengthPpq,
          copy: move.duplicate,
        };
      });
      previewClip.value = previewClips.value[0] ?? null;
      return;
    }
    if (gesture.kind === 'trim') {
      const extent = trimTarget(gesture, point, modifiers);
      previewClip.value = {
        clipId: gesture.origin.id,
        trackId: gesture.origin.trackId,
        startPpq: extent.startPpq,
        lengthPpq: extent.lengthPpq,
        copy: false,
      };
    }
  }

  function onPointerUp(point: ClipPoint, modifiers: ClipModifiers = {}): void {
    const g = gesture;
    gesture = { kind: 'none' };
    previewClip.value = null;
    previewClips.value = [];
    previewFades.value = null;
    previewDraft.value = null;
    previewMarquee.value = null;
    cursor.value = 'default';
    commit(() => commitGesture(g, point, modifiers));
  }

  /** Applies a finished gesture through the project commands. */
  function commitGesture(g: Gesture, point: ClipPoint, modifiers: ClipModifiers): void {
    if (g.kind === 'draw-clip') {
      if (options.canEditTrack?.(g.trackId) === false) return;
      const lengthPpq = drawClipLength(g, point, modifiers);
      const id = commands.createClip(g.trackId, g.startPpq, lengthPpq);
      if (id !== null) commands.selectClip(id);
      return;
    }
    if (g.kind === 'marquee') {
      if (!g.moved) {
        const { trackId } = laneAt(point);
        commands.clearClipSelection?.(trackId ?? undefined);
        return;
      }
      const next = new Set(g.additive ? (options.getSelectedClipIds?.() ?? []) : []);
      const hitIds = marqueeClipIds(g.start, point);
      for (const clipId of hitIds) next.add(clipId);
      if (commands.selectClips) {
        const ids = [...next];
        commands.selectClips(ids, hitIds.at(-1) ?? ids.at(-1));
      } else if (hitIds.length > 0) commands.selectClip(hitIds[hitIds.length - 1]);
      return;
    }
    if (g.kind === 'fade') {
      if (options.canEditClip?.(g.origin.id) === false) return;
      const fades = fadeTarget(g, point, modifiers);
      const originIn = g.origin.fadeInPpq ?? 0;
      const originOut = g.origin.fadeOutPpq ?? 0;
      if (fades.fadeInPpq === originIn && fades.fadeOutPpq === originOut) return;
      // One command call per gesture so the whole drag is one undo entry.
      commands.setClipFades?.(g.origin.id, fades.fadeInPpq, fades.fadeOutPpq);
      return;
    }
    if (g.kind === 'move') {
      if (g.origins.some((origin) => options.canEditClip?.(origin.id) === false)) return;
      const targets = moveTargets(g, point, modifiers);
      const moved = targets.some(
        (target, index) => target.newStartPpq !== g.origins[index].startPpq,
      );
      const trackChanged = targets.some((target) => target.newTrackId !== undefined);
      if (g.duplicate) {
        if (moved) {
          const duplicateId = commands.duplicateClip(g.origin.id, targets[0].newStartPpq);
          commands.selectClip(duplicateId);
        }
        return;
      }
      if (!moved && !trackChanged) return;
      if (targets.length > 1 && commands.moveClips) commands.moveClips(targets);
      else {
        for (const target of targets) {
          commands.moveClip(target.clipId, target.newStartPpq, target.newTrackId);
        }
      }
      return;
    }
    if (g.kind === 'trim') {
      if (options.canEditClip?.(g.origin.id) === false) return;
      const extent = trimTarget(g, point, modifiers);
      if (extent.startPpq === g.origin.startPpq && extent.lengthPpq === g.origin.lengthPpq) return;
      commands.trimClip(g.origin.id, extent.startPpq, extent.lengthPpq);
    }
    // A pending press (plain click) already selected the clip on pointerdown.
  }

  function onDoubleClick(point: ClipPoint, _modifiers: ClipModifiers = {}): void {
    if (hitTestClip(toRects(), point, view, hitOptions())) return;
    const lane = view.laneIndexAtY(point.y);
    const trackIds = options.getTrackIds();
    if (lane < 0 || lane >= trackIds.length) return;
    if (options.canEditTrack?.(trackIds[lane]) === false) return;
    const ppq = Math.max(0, view.xToPpq(point.x));
    const bar = options.getBarRange(ppq);
    commit(() => {
      const id = commands.createClip(trackIds[lane], bar.startPpq, bar.lengthPpq);
      if (id !== null) commands.selectClip(id);
    });
  }

  /** Returns the topmost clip id under a point, or null when none is hit. */
  function hitClipAt(point: ClipPoint): number | null {
    return hitTestClip(toRects(), point, view, hitOptions())?.id ?? null;
  }

  function cancel(): void {
    gesture = { kind: 'none' };
    previewClip.value = null;
    previewClips.value = [];
    previewFades.value = null;
    previewDraft.value = null;
    previewMarquee.value = null;
    cursor.value = 'default';
  }

  return {
    previewClip,
    previewClips,
    previewFades,
    previewDraft,
    previewMarquee,
    cursor,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClick,
    hitClipAt,
    cancel,
  };
}
