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
import { type ClipSplitBlockReason, clipSplitBlockReason } from '@/project/clip-split';
import type { EditorToolId } from '@/ui/editor/tools';
import { clampFadePpq, type FadeEdge, hitTestFadeHandles } from './audio-fades';
import {
  type ArrangeClipRect,
  type ClipHitZone,
  type ClipLaneView,
  type ClipPoint,
  hitTestClip,
} from './clip-hit';

/** Px a pointer must travel from its down point before a drag gesture starts. */
export const DEFAULT_CLIP_DRAG_THRESHOLD_PX = 3;

/** Smallest clip length a trim can produce, in PPQ (a sixteenth note). */
export const DEFAULT_MIN_CLIP_LENGTH_PPQ = 0.25;

/** Modifier-key state captured from the originating pointer event. */
export interface ClipModifiers {
  /** Alt/Option: drag duplicates the clip instead of moving it. */
  alt?: boolean;
  /** Cmd (or Ctrl): bypasses grid snapping while held. */
  meta?: boolean;
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
  /** Clears the active clip after a select-tool click on an empty lane. */
  clearClipSelection?(trackId?: number): void;
  moveClip(clipId: number, newStartPpq: number, newTrackId?: number): void;
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
  /** Returns the bar containing a PPQ position (for double-click creation). */
  getBarRange(ppq: number): ClipBarRange;
  /** Returns the active editor tool (absent = always the select tool). */
  getTool?(): EditorToolId;
  /** Reports why the split tool could not edit the hit clip. */
  onSplitBlocked?(clipId: number, reason: ClipSplitBlockReason): void;
  /** Mutation commands invoked when gestures commit. */
  commands: ClipInteractionCommands;
  /**
   * Returns the source bounds trims of a clip must respect (e.g. an audio
   * clip's backing asset extent), or null for unbounded trimming.
   */
  getSourceBounds?(clipId: number): ClipSourceBounds | null;
  /** Drag start threshold in px. Default {@link DEFAULT_CLIP_DRAG_THRESHOLD_PX}. */
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
  clip: ArrangeClip;
  zone: ClipHitZone;
  duplicate: boolean;
}

interface MoveGesture {
  kind: 'move';
  start: ClipPoint;
  origin: ArrangeClip;
  duplicate: boolean;
}

interface TrimGesture {
  kind: 'trim';
  edge: 'start' | 'end';
  start: ClipPoint;
  origin: ArrangeClip;
}

interface FadeGesture {
  kind: 'fade';
  edge: FadeEdge;
  start: ClipPoint;
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
  | DrawClipGesture;

/** Rounds a PPQ position to the nearest multiple of `step`, clamped to >= 0. */
export function snapToStep(ppq: number, step: number): number {
  if (!(step > 0)) return Math.max(0, ppq);
  return Math.max(0, Math.round(ppq / step) * step);
}

/**
 * Creates the clip interaction state machine for one arrangement surface.
 *
 * @param options - View mapping, state accessors and mutation commands.
 * @returns Reactive gesture state plus pointer handlers.
 */
export function useClipInteractions(options: UseClipInteractionsOptions): ClipInteractions {
  const { view, commands } = options;
  const threshold = options.dragThresholdPx ?? DEFAULT_CLIP_DRAG_THRESHOLD_PX;
  const minLength = options.minLengthPpq ?? DEFAULT_MIN_CLIP_LENGTH_PPQ;

  const previewClip = ref<ClipDragPreview | null>(null);
  const previewFades = ref<ClipFadePreview | null>(null);
  const previewDraft = ref<ClipDraftPreview | null>(null);
  const cursor = ref<ClipCursor>('default');

  let gesture: Gesture = { kind: 'none' };

  /** The active tool ('select' when no tool getter is wired). */
  function currentTool(): EditorToolId {
    return options.getTool?.() ?? 'select';
  }

  /** Resolves the lane and track under a point (track id null when off-lane). */
  function laneAt(point: ClipPoint): { laneIndex: number; trackId: number | null } {
    const trackIds = options.getTrackIds();
    const laneIndex = view.laneIndexAtY(point.y);
    const trackId = laneIndex >= 0 && laneIndex < trackIds.length ? trackIds[laneIndex] : null;
    return { laneIndex, trackId };
  }

  /** Resolves the grid-snapped start cell of a draw at the pointer x. */
  function drawStartPpq(point: ClipPoint, modifiers: ClipModifiers): number {
    const step = options.getGridPpq();
    const ppq = view.xToPpq(point.x);
    return modifiers.meta === true || !(step > 0)
      ? Math.max(0, ppq)
      : Math.max(0, Math.floor(ppq / step) * step);
  }

  /** Resolves the snapped length of an in-flight clip draw (>= one bar). */
  function drawClipLength(g: DrawClipGesture, point: ClipPoint, modifiers: ClipModifiers): number {
    const step = options.getGridPpq();
    const raw = view.xToPpq(point.x);
    const end = modifiers.meta === true ? raw : snapToStep(raw, step);
    const bar = options.getBarRange(g.startPpq).lengthPpq;
    return Math.max(bar, end - g.startPpq);
  }

  /** Deletes the clip under the pointer, if any (erase tool). */
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
    const splitPpq = modifiers.meta === true ? raw : snapToStep(raw, step);
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

  /** Projects the clips into lane-indexed rectangles for the hit-test. */
  function toRects(): ArrangeClipRect[] {
    const laneByTrack = new Map(options.getTrackIds().map((id, index) => [id, index]));
    const rects: ArrangeClipRect[] = [];
    for (const clip of options.getClips()) {
      const laneIndex = laneByTrack.get(clip.trackId);
      if (laneIndex === undefined) continue;
      rects.push({
        id: clip.id,
        laneIndex,
        startPpq: clip.startPpq,
        lengthPpq: clip.lengthPpq,
      });
    }
    return rects;
  }

  /**
   * Finds the topmost audio clip whose fade handle is under the point. Fade
   * handles only exist when the embedder provides the setClipFades command.
   */
  function fadeHandleHit(point: ClipPoint): { clip: ArrangeClip; edge: FadeEdge } | null {
    if (!commands.setClipFades) return null;
    const laneByTrack = new Map(options.getTrackIds().map((id, index) => [id, index]));
    const clips = options.getClips();
    for (let i = clips.length - 1; i >= 0; i--) {
      const clip = clips[i];
      if (clip.kind !== 'audio') continue;
      if (options.canEditClip?.(clip.id) === false) continue;
      const laneIndex = laneByTrack.get(clip.trackId);
      if (laneIndex === undefined) continue;
      const left = view.ppqToX(clip.startPpq);
      const right = view.ppqToX(clip.startPpq + clip.lengthPpq);
      const pxPerPpq = clip.lengthPpq > 0 ? (right - left) / clip.lengthPpq : 0;
      const edge = hitTestFadeHandles(
        point,
        { left, right, top: view.laneTop(laneIndex) },
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
    const delta = view.xToPpq(point.x) - view.xToPpq(g.start.x);
    const length = g.origin.lengthPpq;
    const originIn = g.origin.fadeInPpq ?? 0;
    const originOut = g.origin.fadeOutPpq ?? 0;
    // The fade boundary (not the fade length) snaps to the grid.
    if (g.edge === 'in') {
      const boundary = g.origin.startPpq + originIn + delta;
      const snapped = bypass ? boundary : snapToStep(boundary, step);
      return {
        fadeInPpq: clampFadePpq(snapped - g.origin.startPpq, length, originOut),
        fadeOutPpq: originOut,
      };
    }
    const endPpq = g.origin.startPpq + length;
    const boundary = endPpq - originOut + delta;
    const snapped = bypass ? boundary : snapToStep(boundary, step);
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
    const rawDelta = view.xToPpq(point.x) - view.xToPpq(g.start.x);
    const startPpq =
      modifiers.meta === true
        ? Math.max(0, g.origin.startPpq + rawDelta)
        : snapToStep(g.origin.startPpq + rawDelta, options.getGridPpq());
    // Duplicates stay on the source track; plain moves follow the pointer lane.
    if (g.duplicate) return { startPpq, trackId: g.origin.trackId };
    const trackIds = options.getTrackIds();
    const lane = Math.min(Math.max(0, view.laneIndexAtY(point.y)), Math.max(0, view.laneCount - 1));
    const candidateTrackId = trackIds[lane] ?? g.origin.trackId;
    const trackId =
      candidateTrackId === g.origin.trackId ||
      options.canMoveClipToTrack?.(g.origin.id, candidateTrackId) !== false
        ? candidateTrackId
        : g.origin.trackId;
    return { startPpq, trackId };
  }

  /** Resolves the snapped, clamped trim extent for the dragged edge. */
  function trimTarget(
    g: TrimGesture,
    point: ClipPoint,
    modifiers: ClipModifiers,
  ): { startPpq: number; lengthPpq: number } {
    const bypass = modifiers.meta === true;
    const step = options.getGridPpq();
    const rawDelta = view.xToPpq(point.x) - view.xToPpq(g.start.x);
    const originEnd = g.origin.startPpq + g.origin.lengthPpq;
    const bounds = options.getSourceBounds?.(g.origin.id) ?? null;
    if (g.edge === 'end') {
      let target = bypass ? originEnd + rawDelta : snapToStep(originEnd + rawDelta, step);
      if (bounds) target = Math.min(target, bounds.maxEndPpq);
      const end = Math.max(g.origin.startPpq + minLength, target);
      return { startPpq: g.origin.startPpq, lengthPpq: end - g.origin.startPpq };
    }
    let target = bypass
      ? Math.max(0, g.origin.startPpq + rawDelta)
      : snapToStep(g.origin.startPpq + rawDelta, step);
    if (bounds) target = Math.max(target, bounds.minStartPpq);
    const startPpq = Math.min(originEnd - minLength, target);
    return { startPpq, lengthPpq: originEnd - startPpq };
  }

  function onPointerDown(point: ClipPoint, modifiers: ClipModifiers = {}): void {
    const tool = currentTool();
    if (tool === 'erase') {
      eraseAt(point);
      gesture = { kind: 'none' };
      return;
    }
    if (tool === 'split') {
      splitAt(point, modifiers);
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
        origin: { ...fadeHit.clip },
      };
      return;
    }
    const hit = hitTestClip(toRects(), point, view, hitOptions());
    if (!hit) {
      const { trackId } = laneAt(point);
      commands.clearClipSelection?.(trackId ?? undefined);
      gesture = { kind: 'none' };
      return;
    }
    const clip = options.getClips().find((c) => c.id === hit.id);
    if (!clip) return;
    commands.selectClip(clip.id);
    if (options.canEditClip?.(clip.id) === false) {
      gesture = { kind: 'none' };
      return;
    }
    gesture = {
      kind: 'pending',
      start: point,
      clip: { ...clip },
      zone: hit.zone,
      duplicate: modifiers.alt === true,
    };
  }

  /** Promotes a pending press into a drag gesture once the threshold is passed. */
  function promotePending(pending: PendingGesture): Gesture {
    if (pending.zone === 'body') {
      cursor.value = pending.duplicate ? 'copy' : 'move';
      return {
        kind: 'move',
        start: pending.start,
        origin: pending.clip,
        duplicate: pending.duplicate,
      };
    }
    cursor.value = 'ew-resize';
    return {
      kind: 'trim',
      edge: pending.zone === 'trim-start' ? 'start' : 'end',
      start: pending.start,
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
      const target = moveTarget(gesture, point, modifiers);
      previewClip.value = {
        clipId: gesture.origin.id,
        trackId: target.trackId,
        startPpq: target.startPpq,
        lengthPpq: gesture.origin.lengthPpq,
        copy: gesture.duplicate,
      };
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
    previewFades.value = null;
    previewDraft.value = null;
    cursor.value = 'default';
    if (g.kind === 'draw-clip') {
      if (options.canEditTrack?.(g.trackId) === false) return;
      const lengthPpq = drawClipLength(g, point, modifiers);
      const id = commands.createClip(g.trackId, g.startPpq, lengthPpq);
      if (id !== null) commands.selectClip(id);
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
      if (options.canEditClip?.(g.origin.id) === false) return;
      const target = moveTarget(g, point, modifiers);
      if (
        target.trackId !== g.origin.trackId &&
        options.canMoveClipToTrack?.(g.origin.id, target.trackId) === false
      )
        return;
      const moved = target.startPpq !== g.origin.startPpq;
      const trackChanged = target.trackId !== g.origin.trackId;
      if (g.duplicate) {
        if (moved) {
          const duplicateId = commands.duplicateClip(g.origin.id, target.startPpq);
          commands.selectClip(duplicateId);
        }
        return;
      }
      if (!moved && !trackChanged) return;
      commands.moveClip(g.origin.id, target.startPpq, trackChanged ? target.trackId : undefined);
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
    const id = commands.createClip(trackIds[lane], bar.startPpq, bar.lengthPpq);
    if (id !== null) commands.selectClip(id);
  }

  /** Returns the topmost clip id under a point, or null when none is hit. */
  function hitClipAt(point: ClipPoint): number | null {
    return hitTestClip(toRects(), point, view, hitOptions())?.id ?? null;
  }

  function cancel(): void {
    gesture = { kind: 'none' };
    previewClip.value = null;
    previewFades.value = null;
    previewDraft.value = null;
    cursor.value = 'default';
  }

  return {
    previewClip,
    previewFades,
    previewDraft,
    cursor,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClick,
    hitClipAt,
    cancel,
  };
}
