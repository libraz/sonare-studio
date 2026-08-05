/**
 * Pointer interaction logic for arrangement automation sublanes: click on an
 * empty spot adds a breakpoint, dragging a breakpoint moves it (committed at
 * drag end, previewed locally meanwhile), double-click deletes it and
 * right-click cycles its curve.
 *
 * Framework-light on purpose: only Vue refs for observable state, all
 * mutations through an injected command set, so the gesture logic is
 * unit-testable without mounting components. Handlers return true when the
 * event was consumed so the embedder can fall through to the clip gestures.
 */

import { type Ref, ref } from 'vue';
import type { AutomationCurve, AutomationParam, AutomationPoint } from '@/project/automation';
import { snapPpqToStep } from '@/ui/canvas/timeline-range';
import {
  type AutomationValueDomain,
  automationValueToY,
  automationYToValue,
} from './automation-rows';
import type { ClipPoint } from './clip-hit';
import { type ClipModifiers, DEFAULT_CLIP_DRAG_THRESHOLD_PX } from './use-clip-interactions';

/** Px radius around a breakpoint center that counts as a hit. */
export const AUTOMATION_POINT_HIT_RADIUS_PX = 6;

/** Curve cycling order applied by right-clicking a breakpoint. */
const CURVE_CYCLE: Record<AutomationCurve, AutomationCurve> = {
  linear: 'exponential',
  exponential: 'hold',
  hold: 's-curve',
  's-curve': 'linear',
};

/** Geometry of one expanded automation sublane in viewport px. */
export interface AutomationSublane {
  /** Id of the owning track. */
  trackId: number;
  /** Parameter the sublane currently edits. */
  param: AutomationParam;
  /** Sublane top edge in viewport px. */
  top: number;
  /** Sublane height in px. */
  height: number;
  /** Display domain for an insert-parameter sublane; absent = fader/pan/[0,1]. */
  insertDomain?: AutomationValueDomain;
}

/** View contract for the automation gestures. */
export interface AutomationInteractionsView {
  /** Converts a PPQ position to a viewport x coordinate in px. */
  ppqToX(ppq: number): number;
  /** Converts a viewport x coordinate to a PPQ position. */
  xToPpq(x: number): number;
  /** Sublane under a viewport point, or null when none is there. */
  sublaneAt(point: ClipPoint): AutomationSublane | null;
}

/** Command surface the gestures call into (src/project/commands.ts in the app). */
export interface AutomationInteractionCommands {
  /** Replaces a lane's point list (insertion order is irrelevant; it sorts). */
  setPoints(trackId: number, param: AutomationParam, points: AutomationPoint[]): void;
}

/** Configuration for {@link useAutomationInteractions}. */
export interface UseAutomationInteractionsOptions {
  /** Coordinate mapping and sublane lookup for the arrangement viewport. */
  view: AutomationInteractionsView;
  /** Returns a lane's current points ([] when the lane does not exist yet). */
  getLanePoints(trackId: number, param: AutomationParam): ReadonlyArray<AutomationPoint>;
  /** Returns the current snap grid step in PPQ (<= 0 disables snapping). */
  getGridPpq(): number;
  /** Optionally resolves a PPQ position on a meter-aware snap grid. */
  snapPpq?(ppq: number): number;
  /** Mutation commands invoked when gestures commit. */
  commands: AutomationInteractionCommands;
  /** Drag start threshold in px. Default {@link DEFAULT_CLIP_DRAG_THRESHOLD_PX}. */
  dragThresholdPx?: number;
}

/** In-flight breakpoint drag, for rendering only. */
export interface AutomationDragPreview {
  /** Id of the track whose sublane is being edited. */
  trackId: number;
  /** Parameter of the edited lane. */
  param: AutomationParam;
  /** Full point list with the dragged point at its preview position, sorted. */
  points: AutomationPoint[];
}

/** Identity of the breakpoint under the pointer, for hover highlighting. */
export interface AutomationHover {
  /** Id of the track whose sublane is hovered. */
  trackId: number;
  /** Parameter of the hovered lane. */
  param: AutomationParam;
  /** Index of the hovered point in the lane's sorted point list. */
  index: number;
}

/** Reactive state and event handlers returned by {@link useAutomationInteractions}. */
export interface AutomationInteractions {
  /** In-flight breakpoint drag, or null when no drag is running. */
  preview: Ref<AutomationDragPreview | null>;
  /** Breakpoint under the pointer, or null. */
  hover: Ref<AutomationHover | null>;
  /** Cursor to show while the pointer is over a sublane; null = not ours. */
  cursor: Ref<string | null>;
  /** Handles pointerdown; true when the press landed on a sublane. */
  onPointerDown(point: ClipPoint, modifiers?: ClipModifiers): boolean;
  /** Handles pointermove; true while a gesture runs or a sublane is hovered. */
  onPointerMove(point: ClipPoint, modifiers?: ClipModifiers): boolean;
  /** Handles pointerup; commits the gesture. True when it consumed the press. */
  onPointerUp(point: ClipPoint, modifiers?: ClipModifiers): boolean;
  /** Handles double-click; deletes a hit breakpoint. True when on a sublane. */
  onDoubleClick(point: ClipPoint): boolean;
  /** Handles contextmenu; cycles a hit breakpoint's curve. True when hit. */
  onContextMenu(point: ClipPoint): boolean;
  /** Aborts any in-flight gesture without committing (e.g. pointercancel). */
  cancel(): void;
}

interface AddGesture {
  kind: 'add';
  start: ClipPoint;
  sublane: AutomationSublane;
}

interface PointGesture {
  kind: 'point';
  start: ClipPoint;
  sublane: AutomationSublane;
  /** Index of the pressed point in the origin list. */
  index: number;
  /** Snapshot of the lane points at press time. */
  origin: AutomationPoint[];
  /** True once the drag threshold has been passed. */
  dragging: boolean;
}

type Gesture = { kind: 'none' } | AddGesture | PointGesture;

/**
 * Creates the automation sublane gesture state machine for one arrangement
 * surface.
 *
 * @param options - View mapping, state accessors and mutation commands.
 * @returns Reactive gesture state plus pointer handlers.
 */
export function useAutomationInteractions(
  options: UseAutomationInteractionsOptions,
): AutomationInteractions {
  const { view, commands } = options;
  const threshold = options.dragThresholdPx ?? DEFAULT_CLIP_DRAG_THRESHOLD_PX;

  const preview = ref<AutomationDragPreview | null>(null);
  const hover = ref<AutomationHover | null>(null);
  const cursor = ref<string | null>(null);

  let gesture: Gesture = { kind: 'none' };

  /** Index of the breakpoint under the point, or -1 (topmost-drawn wins). */
  function hitPointIndex(
    points: ReadonlyArray<AutomationPoint>,
    sublane: AutomationSublane,
    point: ClipPoint,
  ): number {
    for (let i = points.length - 1; i >= 0; i--) {
      const x = view.ppqToX(points[i].ppq);
      const y = automationValueToY(
        sublane.param,
        points[i].value,
        sublane.top,
        sublane.height,
        sublane.insertDomain,
      );
      if (Math.hypot(point.x - x, point.y - y) <= AUTOMATION_POINT_HIT_RADIUS_PX) return i;
    }
    return -1;
  }

  /** Snapped, clamped (ppq, value) for a pointer position in a sublane. */
  function pointAt(
    sublane: AutomationSublane,
    point: ClipPoint,
    modifiers: ClipModifiers,
  ): { ppq: number; value: number } {
    const raw = view.xToPpq(point.x);
    const ppq =
      modifiers.meta === true
        ? Math.max(0, raw)
        : (options.snapPpq?.(raw) ?? snapPpqToStep(raw, options.getGridPpq()));
    return {
      ppq,
      value: automationYToValue(
        sublane.param,
        point.y,
        sublane.top,
        sublane.height,
        sublane.insertDomain,
      ),
    };
  }

  /** Builds the preview point list with the dragged point moved, sorted. */
  function dragPoints(
    g: PointGesture,
    point: ClipPoint,
    modifiers: ClipModifiers,
  ): AutomationPoint[] {
    const target = pointAt(g.sublane, point, modifiers);
    const moved: AutomationPoint = { ...g.origin[g.index], ppq: target.ppq, value: target.value };
    const points = g.origin.map((p, i) => (i === g.index ? moved : { ...p }));
    points.sort((a, b) => a.ppq - b.ppq);
    return points;
  }

  function onPointerDown(point: ClipPoint, _modifiers: ClipModifiers = {}): boolean {
    const sublane = view.sublaneAt(point);
    if (!sublane) return false;
    const points = options.getLanePoints(sublane.trackId, sublane.param);
    const index = hitPointIndex(points, sublane, point);
    gesture =
      index >= 0
        ? {
            kind: 'point',
            start: point,
            sublane,
            index,
            origin: points.map((p) => ({ ...p })),
            dragging: false,
          }
        : { kind: 'add', start: point, sublane };
    return true;
  }

  function onPointerMove(point: ClipPoint, modifiers: ClipModifiers = {}): boolean {
    if (gesture.kind === 'point') {
      if (!gesture.dragging) {
        if (Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) < threshold) {
          return true;
        }
        gesture.dragging = true;
        cursor.value = 'grabbing';
      }
      preview.value = {
        trackId: gesture.sublane.trackId,
        param: gesture.sublane.param,
        points: dragPoints(gesture, point, modifiers),
      };
      return true;
    }
    if (gesture.kind === 'add') return true;
    const sublane = view.sublaneAt(point);
    if (!sublane) {
      hover.value = null;
      cursor.value = null;
      return false;
    }
    const points = options.getLanePoints(sublane.trackId, sublane.param);
    const index = hitPointIndex(points, sublane, point);
    hover.value = index >= 0 ? { trackId: sublane.trackId, param: sublane.param, index } : null;
    cursor.value = index >= 0 ? 'pointer' : 'crosshair';
    return true;
  }

  function onPointerUp(point: ClipPoint, modifiers: ClipModifiers = {}): boolean {
    const g = gesture;
    gesture = { kind: 'none' };
    preview.value = null;
    if (g.kind === 'none') return false;
    cursor.value = null;
    if (g.kind === 'add') {
      // Plain click only: a press dragged away from its spot adds nothing.
      if (Math.hypot(point.x - g.start.x, point.y - g.start.y) >= threshold) return true;
      const target = pointAt(g.sublane, g.start, modifiers);
      const points = options
        .getLanePoints(g.sublane.trackId, g.sublane.param)
        .map((p) => ({ ...p }));
      points.push(target);
      commands.setPoints(g.sublane.trackId, g.sublane.param, points);
      return true;
    }
    if (g.dragging) {
      commands.setPoints(g.sublane.trackId, g.sublane.param, dragPoints(g, point, modifiers));
    }
    return true;
  }

  function onDoubleClick(point: ClipPoint): boolean {
    const sublane = view.sublaneAt(point);
    if (!sublane) return false;
    const points = options.getLanePoints(sublane.trackId, sublane.param);
    const index = hitPointIndex(points, sublane, point);
    if (index >= 0) {
      hover.value = null;
      commands.setPoints(
        sublane.trackId,
        sublane.param,
        points.filter((_, i) => i !== index).map((p) => ({ ...p })),
      );
    }
    // Consumed either way so the clip gestures never create clips here.
    return true;
  }

  function onContextMenu(point: ClipPoint): boolean {
    const sublane = view.sublaneAt(point);
    if (!sublane) return false;
    const points = options.getLanePoints(sublane.trackId, sublane.param);
    const index = hitPointIndex(points, sublane, point);
    if (index < 0) return false;
    commands.setPoints(
      sublane.trackId,
      sublane.param,
      points.map((p, i) =>
        i === index ? { ...p, curve: CURVE_CYCLE[p.curve ?? 'linear'] } : { ...p },
      ),
    );
    return true;
  }

  function cancel(): void {
    gesture = { kind: 'none' };
    preview.value = null;
    hover.value = null;
    cursor.value = null;
  }

  return {
    preview,
    hover,
    cursor,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClick,
    onContextMenu,
    cancel,
  };
}
