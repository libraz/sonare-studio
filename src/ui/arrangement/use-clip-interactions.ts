/**
 * Pointer interaction logic for arrangement clips: click selection, drag move
 * (horizontal snap + vertical lane change), edge trims, alt/option-drag
 * duplication and double-click clip creation on empty lanes.
 *
 * Framework-light on purpose: only Vue refs for observable state, all
 * mutations through an injected command set, so the gesture logic is
 * unit-testable without mounting components.
 */

import { type Ref, ref } from 'vue';
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
  moveClip(clipId: number, newStartPpq: number, newTrackId?: number): void;
  trimClip(clipId: number, newStartPpq: number, newLengthPpq: number): void;
  duplicateClip(clipId: number, newStartPpq: number): number;
  /** Creates an empty clip and returns its id. */
  createClip(trackId: number, startPpq: number, lengthPpq: number): number;
}

/** Configuration for {@link useClipInteractions}. */
export interface UseClipInteractionsOptions {
  /** Coordinate mapping for the arrangement viewport. */
  view: ClipInteractionsView;
  /** Returns the current clip list (draw order, last = topmost). */
  getClips(): ReadonlyArray<ArrangeClip>;
  /** Returns track ids in lane order (index = lane index). */
  getTrackIds(): ReadonlyArray<number>;
  /** Returns the current snap grid step in PPQ (<= 0 disables snapping). */
  getGridPpq(): number;
  /** Returns the bar containing a PPQ position (for double-click creation). */
  getBarRange(ppq: number): ClipBarRange;
  /** Mutation commands invoked when gestures commit. */
  commands: ClipInteractionCommands;
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

/** CSS cursor reflecting what a pointer press at the hovered point would do. */
export type ClipCursor = 'default' | 'pointer' | 'move' | 'copy' | 'ew-resize';

/** Reactive state and event handlers returned by {@link useClipInteractions}. */
export interface ClipInteractions {
  /** In-flight drag geometry, or null when no drag is running. */
  previewClip: Ref<ClipDragPreview | null>;
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

type Gesture = { kind: 'none' } | PendingGesture | MoveGesture | TrimGesture;

/** Rounds a PPQ position to the nearest multiple of `step`, clamped to >= 0. */
function snapToStep(ppq: number, step: number): number {
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
  const cursor = ref<ClipCursor>('default');

  let gesture: Gesture = { kind: 'none' };

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
    return { startPpq, trackId: trackIds[lane] ?? g.origin.trackId };
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
    if (g.edge === 'end') {
      const target = bypass ? originEnd + rawDelta : snapToStep(originEnd + rawDelta, step);
      const end = Math.max(g.origin.startPpq + minLength, target);
      return { startPpq: g.origin.startPpq, lengthPpq: end - g.origin.startPpq };
    }
    const target = bypass
      ? Math.max(0, g.origin.startPpq + rawDelta)
      : snapToStep(g.origin.startPpq + rawDelta, step);
    const startPpq = Math.min(originEnd - minLength, target);
    return { startPpq, lengthPpq: originEnd - startPpq };
  }

  function onPointerDown(point: ClipPoint, modifiers: ClipModifiers = {}): void {
    const hit = hitTestClip(toRects(), point, view, hitOptions());
    if (!hit) {
      gesture = { kind: 'none' };
      return;
    }
    const clip = options.getClips().find((c) => c.id === hit.id);
    if (!clip) return;
    commands.selectClip(clip.id);
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
      const hit = hitTestClip(toRects(), point, view, hitOptions());
      cursor.value = hit ? (hit.zone === 'body' ? 'pointer' : 'ew-resize') : 'default';
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
    cursor.value = 'default';
    if (g.kind === 'move') {
      const target = moveTarget(g, point, modifiers);
      const moved = target.startPpq !== g.origin.startPpq;
      const trackChanged = target.trackId !== g.origin.trackId;
      if (g.duplicate) {
        if (moved) commands.duplicateClip(g.origin.id, target.startPpq);
        return;
      }
      if (!moved && !trackChanged) return;
      commands.moveClip(g.origin.id, target.startPpq, trackChanged ? target.trackId : undefined);
      return;
    }
    if (g.kind === 'trim') {
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
    const ppq = Math.max(0, view.xToPpq(point.x));
    const bar = options.getBarRange(ppq);
    const id = commands.createClip(trackIds[lane], bar.startPpq, bar.lengthPpq);
    commands.selectClip(id);
  }

  function cancel(): void {
    gesture = { kind: 'none' };
    previewClip.value = null;
    cursor.value = 'default';
  }

  return {
    previewClip,
    cursor,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClick,
    cancel,
  };
}
