/**
 * Pointer routing for the arrangement canvas: dispatches a press to the ruler
 * scrub, the automation sublane, the take sub-rows or the clip gestures and
 * keeps that target for the rest of the gesture, then routes moves, releases,
 * double-clicks and the context menu the same way. Ruler presses seek the
 * transport; right-clicks raise the ruler or clip context-menu requests (the
 * automation sublane owns its own point menu and is offered the press first).
 *
 * The composable holds the per-gesture closure state and exposes the event
 * handlers plus the merged lane cursor; it raises viewport-level requests
 * through the injected emit callbacks so the host component stays the I/O edge.
 */

import { type ComputedRef, computed, type Ref } from 'vue';
import { RULER_HEIGHT_PX } from '@/components/arrangement/theme';
import type { AutomationInteractions } from '@/ui/arrangement/use-automation-interactions';
import type { ClipInteractions, ClipModifiers } from '@/ui/arrangement/use-clip-interactions';
import type { TakeInteractions } from '@/ui/arrangement/use-take-interactions';
import type { TimelineRange } from '@/ui/canvas/timeline-range';

/** Right-click payload raised for the ruler or a clip lane. */
export interface ContextMenuRequest {
  /** Client x of the menu anchor. */
  x: number;
  /** Client y of the menu anchor. */
  y: number;
  /** Timeline position under the pointer in PPQ. */
  ppq: number;
}

/** Inputs for {@link usePointerRouting}. */
export interface PointerRoutingOptions {
  /** Wrapper element used to map client coordinates to local px. */
  wrapper: Ref<HTMLElement | null>;
  /** Returns the current timeline viewport. */
  range: () => TimelineRange;
  /** Automation sublane gesture state machine. */
  automation: AutomationInteractions;
  /** Take sub-row gesture state machine. */
  takes: TakeInteractions;
  /** Clip gesture state machine. */
  interactions: ClipInteractions;
  /** Requests a transport seek to a timeline position (ruler press/scrub). */
  onRulerSeek: (ppq: number) => void;
  /** Requests the ruler context menu. */
  onRulerContext: (request: ContextMenuRequest) => void;
  /** Requests the clip context menu (clipId null = no clip hit). */
  onClipContext: (request: ContextMenuRequest & { clipId: number | null }) => void;
}

/** Handlers and cursor exposed for the canvas template bindings. */
export interface PointerRouting {
  /** Cursor over the lanes (a hot sublane wins over clip gestures). */
  laneCursor: ComputedRef<string>;
  onPointerDown(event: PointerEvent): void;
  onPointerMove(event: PointerEvent): void;
  onPointerUp(event: PointerEvent): void;
  onPointerCancel(): void;
  onDoubleClick(event: MouseEvent): void;
  onContextMenu(event: MouseEvent): void;
}

/**
 * Wires the arrangement pointer routing and returns the template handlers.
 *
 * @param options - Element ref, viewport accessor, gesture machines and emits.
 * @returns The lane cursor and pointer/double-click/context-menu handlers.
 */
export function usePointerRouting(options: PointerRoutingOptions): PointerRouting {
  const {
    wrapper,
    range,
    automation,
    takes,
    interactions,
    onRulerSeek,
    onRulerContext,
    onClipContext,
  } = options;

  /** True while a ruler press scrubs the transport. */
  let rulerScrub = false;

  /** Which gesture machine consumed the current press. */
  let pressTarget: 'none' | 'automation' | 'takes' | 'clips' = 'none';

  /** Cursor over the lanes: a hot sublane (automation, then takes) wins. */
  const laneCursor = computed(
    () => automation.cursor.value ?? takes.cursor.value ?? interactions.cursor.value,
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
      onRulerSeek(Math.max(0, range().xToPpq(point.x)));
      return;
    }
    if (automation.onPointerDown(point, modifiers(event))) {
      pressTarget = 'automation';
      return;
    }
    if (takes.onPointerDown(point)) {
      pressTarget = 'takes';
      return;
    }
    pressTarget = 'clips';
    interactions.onPointerDown(point, modifiers(event));
  }

  function onPointerMove(event: PointerEvent): void {
    const point = localPoint(event);
    if (rulerScrub) {
      onRulerSeek(Math.max(0, range().xToPpq(point.x)));
      return;
    }
    // While a press is in flight, only its own machine sees the moves.
    if (pressTarget === 'automation') {
      automation.onPointerMove(point, modifiers(event));
      return;
    }
    if (pressTarget === 'takes') {
      takes.onPointerMove(point);
      return;
    }
    if (pressTarget === 'clips') {
      interactions.onPointerMove(point, modifiers(event));
      return;
    }
    if (automation.onPointerMove(point, modifiers(event))) return;
    if (takes.onPointerMove(point)) return;
    interactions.onPointerMove(point, modifiers(event));
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
      automation.onPointerUp(localPoint(event), modifiers(event));
      return;
    }
    if (target === 'takes') {
      takes.onPointerUp(localPoint(event));
      return;
    }
    interactions.onPointerUp(localPoint(event), modifiers(event));
  }

  function onPointerCancel(): void {
    rulerScrub = false;
    pressTarget = 'none';
    automation.cancel();
    takes.cancel();
    interactions.cancel();
  }

  function onDoubleClick(event: MouseEvent): void {
    const point = localPoint(event);
    if (point.y < RULER_HEIGHT_PX) return;
    if (automation.onDoubleClick(point)) return;
    // Take sub-rows are editing-only surfaces: treating their empty space as
    // a track lane would create a new clip beneath an expanded comp lane.
    if (takes.isTakeRowAt(point)) return;
    interactions.onDoubleClick(point, modifiers(event));
  }

  function onContextMenu(event: MouseEvent): void {
    const point = localPoint(event);
    // The automation sublane owns its own point menu; defer to it first.
    if (automation.onContextMenu(point)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const ppq = Math.max(0, range().xToPpq(point.x));
    if (point.y < RULER_HEIGHT_PX) {
      onRulerContext({ x: event.clientX, y: event.clientY, ppq });
      return;
    }
    onClipContext({
      x: event.clientX,
      y: event.clientY,
      clipId: interactions.hitClipAt(point),
      ppq,
    });
  }

  return {
    laneCursor,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onDoubleClick,
    onContextMenu,
  };
}
