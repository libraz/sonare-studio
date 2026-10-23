/**
 * Pointer interaction logic for arrangement take sub-rows (comping): a plain
 * click inside a comped clip's span selects the pressed take for the whole
 * clip, while a horizontal drag selects it over the dragged clip-relative
 * range and keeps the current comp selection outside it
 * (see compSegmentsWithRange in src/project/comping.ts).
 *
 * Framework-light on purpose: only Vue refs for observable state, all
 * mutations through an injected command set, so the gesture logic is
 * unit-testable without mounting components. Handlers return true when the
 * event was consumed so the embedder can fall through to the clip gestures.
 */

import { type Ref, ref } from 'vue';
import { clamp } from '@/lib/math';
import { type CompableClipFields, compSegmentsWithRange } from '@/project/comping';
import type { ClipCompSegment } from '@/project/types';
import type { ClipPoint } from './clip-hit';

/** Smallest horizontal drag treated as a range selection, in PPQ (a 1/32 note). */
export const MIN_COMP_DRAG_PPQ = 0.125;

/** The clip fields the take gestures read (arrangement extent plus comping). */
export interface TakeLaneClip extends CompableClipFields {
  /** Stable clip id. */
  id: number;
  /** Id of the owning track. */
  trackId: number;
  /** MIDI cycle takes; these are selected as whole takes rather than ranged comps. */
  midiTakes?: ReadonlyArray<unknown>;
  /** Take playing where no comp segment applies; defaults to the last take. */
  midiActiveTakeIndex?: number;
  midiCompSegments?: ClipCompSegment[];
  /** Timeline start of the clip, in PPQ. */
  startPpq: number;
}

/** Identity of a take sub-row under a viewport point. */
export interface TakeRowHit {
  /** Id of the owning track. */
  trackId: number;
  /** Index of the take sub-row (0 = directly below the track lane). */
  takeIndex: number;
}

/** View contract for the take gestures. */
export interface TakeInteractionsView {
  /** Converts a PPQ position to a viewport x coordinate in px. */
  ppqToX(ppq: number): number;
  /** Converts a viewport x coordinate to a PPQ position. */
  xToPpq(x: number): number;
  /** Take sub-row under a viewport point, or null when none is there. */
  takeRowAt(point: ClipPoint): TakeRowHit | null;
}

/** Command surface the gestures call into (src/project/commands.ts in the app). */
export interface TakeInteractionCommands {
  /** Selects one take for the whole clip (plain click). */
  setActiveTake(clipId: number, takeIndex: number): void;
  /** Replaces a clip's comp selection (range drag). */
  setCompSegments(clipId: number, segments: ClipCompSegment[]): void;
  /** Selects one complete MIDI cycle take. */
  setActiveMidiTake?(clipId: number, takeIndex: number): void;
  setMidiCompSegments?(clipId: number, segments: ClipCompSegment[]): void;
}

/** Configuration for {@link useTakeInteractions}. */
export interface UseTakeInteractionsOptions {
  /** Coordinate mapping and take sub-row lookup for the arrangement viewport. */
  view: TakeInteractionsView;
  /** Returns the current clip list (clips without takes are ignored). */
  getClips(): ReadonlyArray<TakeLaneClip>;
  /** Returns false when comp editing is disabled for the owning track. */
  canEditTrack?(trackId: number): boolean;
  /** Mutation commands invoked when gestures commit. */
  commands: TakeInteractionCommands;
  /**
   * Snaps a clip-relative comp edge (for example into a silence every take
   * shares); absent leaves edges where the pointer put them.
   */
  snapEdge?(clipId: number, ppq: number): number;
}

/** In-flight comp range drag, for rendering only. */
export interface TakeDragPreview {
  /** Id of the comped clip being edited. */
  clipId: number;
  /** Index of the dragged take sub-row. */
  takeIndex: number;
  /** Range start relative to the clip window, in PPQ. */
  startPpq: number;
  /** Range end relative to the clip window, in PPQ. */
  endPpq: number;
}

/** Reactive state and event handlers returned by {@link useTakeInteractions}. */
export interface TakeInteractions {
  /** In-flight comp range drag, or null when no drag is running. */
  preview: Ref<TakeDragPreview | null>;
  /** Cursor to show while the pointer is over a take sub-row; null = not ours. */
  cursor: Ref<string | null>;
  /** True when a point belongs to an expanded take sub-row, even outside a clip span. */
  isTakeRowAt(point: ClipPoint): boolean;
  /** Handles pointerdown; true when the press landed on a take sub-row. */
  onPointerDown(point: ClipPoint): boolean;
  /** Handles pointermove; true while a gesture runs or a take sub-row is hovered. */
  onPointerMove(point: ClipPoint): boolean;
  /** Handles pointerup; commits the gesture. True when it consumed the press. */
  onPointerUp(point: ClipPoint): boolean;
  /** Aborts any in-flight gesture without committing (e.g. pointercancel). */
  cancel(): void;
}

interface DragGesture {
  /** Snapshot of the pressed clip at press time. */
  clip: TakeLaneClip;
  /** Index of the pressed take sub-row. */
  takeIndex: number;
  /** Press position relative to the clip window, clamped, in PPQ. */
  downPpq: number;
}

/**
 * Creates the take sub-row (comping) gesture state machine for one
 * arrangement surface.
 *
 * @param options - View mapping, state accessors and mutation commands.
 * @returns Reactive gesture state plus pointer handlers.
 */
export function useTakeInteractions(options: UseTakeInteractionsOptions): TakeInteractions {
  const { view, commands } = options;

  const preview = ref<TakeDragPreview | null>(null);
  const cursor = ref<string | null>(null);

  /** True between a consumed pointerdown and its pointerup. */
  let pressed = false;
  /** In-flight drag, or null when the press missed every clip span. */
  let drag: DragGesture | null = null;

  /** Comped clip on the track whose span contains `ppq` and that has the take. */
  function clipAt(trackId: number, takeIndex: number, ppq: number): TakeLaneClip | null {
    for (const clip of options.getClips()) {
      if (
        clip.trackId !== trackId ||
        Math.max(clip.takes?.length ?? 0, clip.midiTakes?.length ?? 0) <= takeIndex
      )
        continue;
      if (ppq >= clip.startPpq && ppq < clip.startPpq + clip.lengthPpq) return clip;
    }
    return null;
  }

  /** Pointer x as a clip-relative PPQ position, clamped into the clip window. */
  function clipRelativePpq(clip: TakeLaneClip, x: number): number {
    return clamp(view.xToPpq(x) - clip.startPpq, 0, clip.lengthPpq);
  }

  /** The dragged range with both edges snapped. */
  function dragRange(g: DragGesture, x: number): { start: number; end: number } {
    const current = clipRelativePpq(g.clip, x);
    const snap = (ppq: number): number => options.snapEdge?.(g.clip.id, ppq) ?? ppq;
    const a = snap(g.downPpq);
    const b = snap(current);
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }

  function onPointerDown(point: ClipPoint): boolean {
    const hit = view.takeRowAt(point);
    if (!hit) return false;
    pressed = true;
    if (options.canEditTrack?.(hit.trackId) === false) return true;
    const clip = clipAt(hit.trackId, hit.takeIndex, view.xToPpq(point.x));
    if (clip) {
      drag = {
        clip: { ...clip },
        takeIndex: hit.takeIndex,
        downPpq: clipRelativePpq(clip, point.x),
      };
    }
    // Consumed even outside clip spans so clip gestures never start here.
    return true;
  }

  function onPointerMove(point: ClipPoint): boolean {
    if (drag) {
      const { start, end } = dragRange(drag, point.x);
      preview.value = {
        clipId: drag.clip.id,
        takeIndex: drag.takeIndex,
        startPpq: start,
        endPpq: end,
      };
      return true;
    }
    if (pressed) return true;
    const hit = view.takeRowAt(point);
    if (!hit) {
      cursor.value = null;
      return false;
    }
    cursor.value =
      options.canEditTrack?.(hit.trackId) === false
        ? 'default'
        : clipAt(hit.trackId, hit.takeIndex, view.xToPpq(point.x))
          ? 'crosshair'
          : 'default';
    return true;
  }

  function onPointerUp(point: ClipPoint): boolean {
    const wasPressed = pressed;
    const g = drag;
    pressed = false;
    drag = null;
    preview.value = null;
    if (!g) return wasPressed;
    const { start, end } = dragRange(g, point.x);
    if (g.clip.midiTakes !== undefined) {
      if (end - start < MIN_COMP_DRAG_PPQ) commands.setActiveMidiTake?.(g.clip.id, g.takeIndex);
      else {
        // Without a comp the whole clip plays the active take, as the take lanes draw it.
        const activeTakeIndex = Math.min(
          Math.max(0, g.clip.midiActiveTakeIndex ?? g.clip.midiTakes.length - 1),
          g.clip.midiTakes.length - 1,
        );
        commands.setMidiCompSegments?.(
          g.clip.id,
          compSegmentsWithRange(
            {
              ...g.clip,
              takes: g.clip.midiTakes,
              compSegments: g.clip.midiCompSegments ?? [
                { startPpq: 0, takeIndex: activeTakeIndex },
              ],
            },
            start,
            end,
            g.takeIndex,
          ),
        );
      }
    } else if (end - start < MIN_COMP_DRAG_PPQ) {
      commands.setActiveTake(g.clip.id, g.takeIndex);
    } else {
      commands.setCompSegments(g.clip.id, compSegmentsWithRange(g.clip, start, end, g.takeIndex));
    }
    return true;
  }

  function cancel(): void {
    pressed = false;
    drag = null;
    preview.value = null;
    cursor.value = null;
  }

  return {
    preview,
    cursor,
    isTakeRowAt: (point) => view.takeRowAt(point) !== null,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    cancel,
  };
}
