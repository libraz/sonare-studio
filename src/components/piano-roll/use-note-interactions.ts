/**
 * Pointer/keyboard interaction logic for the piano-roll note grid (smart select
 * tool): marquee selection, click selection, note move/resize/duplicate drags,
 * double-click note creation and selection deletion.
 *
 * The composable is framework-light on purpose: it only depends on Vue refs
 * for its observable state, and all mutations go through an injected command
 * set, so the gesture logic is unit-testable without mounting components.
 */

import { type Ref, ref } from 'vue';
import type { EditorNote, EditorNoteUpdate, NewEditorNote } from '@/project/types';
import {
  hitTestNote,
  type MarqueeRect,
  marqueeSelect,
  type NoteHitZone,
  type NoteRect,
} from '@/ui/canvas/hit-test';
import { MAX_PITCH, MIN_PITCH } from '@/ui/canvas/timeline-range';

/** Px a pointer must travel from its down point before a drag gesture starts. */
export const DEFAULT_DRAG_THRESHOLD_PX = 3;

/** Smallest note duration a resize can produce (a sixty-fourth note in PPQ). */
export const DEFAULT_MIN_DURATION_PPQ = 0.0625;

/** A pointer position in note-grid viewport px coordinates. */
export interface InteractionPoint {
  x: number;
  y: number;
}

/** Modifier-key state captured from the originating pointer/keyboard event. */
export interface InteractionModifiers {
  /** Shift: additive selection (click and marquee). */
  shift?: boolean;
  /** Alt/Option: drag duplicates the targeted notes instead of moving them. */
  alt?: boolean;
  /** Cmd (or Ctrl): bypasses grid snapping while held. */
  meta?: boolean;
}

/**
 * View contract the interactions need: px-to-musical mapping in both
 * directions. `TimelineRange` satisfies this structurally.
 */
export interface InteractionView {
  ppqToX(ppq: number): number;
  xToPpq(x: number): number;
  pitchToY(pitch: number): number;
  yToPitch(y: number): number;
  readonly rowHeight: number;
}

/** Command surface the gestures call into (src/project/commands.ts in the app). */
export interface InteractionCommands {
  addNote(input: NewEditorNote): number;
  updateNotes(updates: ReadonlyArray<EditorNoteUpdate>): void;
  deleteNotes(ids: Iterable<number>): void;
  setSelection(ids: Iterable<number>): void;
}

/** Configuration for {@link useNoteInteractions}. */
export interface UseNoteInteractionsOptions {
  /** Coordinate mapping for the note grid viewport. */
  view: InteractionView;
  /** Returns the current note list (draw order, last = topmost). */
  getNotes(): ReadonlyArray<EditorNote>;
  /** Returns the current selection as note ids. */
  getSelection(): ReadonlySet<number>;
  /** Returns the current snap grid step in PPQ. */
  getGridPpq(): number;
  /** Mutation commands invoked when gestures commit. */
  commands: InteractionCommands;
  /** Drag start threshold in px. Default {@link DEFAULT_DRAG_THRESHOLD_PX}. */
  dragThresholdPx?: number;
  /** Minimum note duration kept by resize, in PPQ. Default {@link DEFAULT_MIN_DURATION_PPQ}. */
  minDurationPpq?: number;
  /** Px distance from a note edge treated as a resize handle. */
  resizeTolerancePx?: number;
}

/** CSS cursor reflecting what a pointer press at the hovered point would do. */
export type InteractionCursor = 'default' | 'pointer' | 'ew-resize' | 'move' | 'crosshair';

/** Reactive state and event handlers returned by {@link useNoteInteractions}. */
export interface NoteInteractions {
  /** Active marquee rectangle in viewport px, or null when no marquee drag is running. */
  marquee: Ref<MarqueeRect | null>;
  /**
   * Full note list with the in-flight gesture applied (moved/resized notes, or
   * appended duplicate copies with negative ids), for rendering only. Null
   * while no drag is in progress; renderers should then draw the store notes.
   */
  previewNotes: Ref<EditorNote[] | null>;
  /** Cursor to show over the note grid. */
  cursor: Ref<InteractionCursor>;
  /** Handles pointerdown on the note grid (point in local px). */
  onPointerDown(point: InteractionPoint, modifiers?: InteractionModifiers): void;
  /** Handles pointermove (both hover feedback and drag updates). */
  onPointerMove(point: InteractionPoint, modifiers?: InteractionModifiers): void;
  /** Handles pointerup; commits the gesture through the commands. */
  onPointerUp(point: InteractionPoint, modifiers?: InteractionModifiers): void;
  /** Handles double-click; creates a snapped note on empty space. */
  onDoubleClick(point: InteractionPoint, modifiers?: InteractionModifiers): void;
  /**
   * Handles a key press (`event.key` value).
   *
   * @returns True when the key was consumed (caller should preventDefault).
   */
  onKeyDown(key: string): boolean;
  /** Aborts any in-flight gesture without committing (e.g. pointercancel). */
  cancel(): void;
}

/** Horizontal/vertical displacement of a move gesture in musical units. */
interface MoveDeltas {
  deltaPpq: number;
  deltaPitch: number;
}

interface PendingNoteGesture {
  kind: 'pending-note';
  start: InteractionPoint;
  noteId: number;
  zone: NoteHitZone;
  targetIds: number[];
  wasSelected: boolean;
  shift: boolean;
  duplicate: boolean;
}

interface PendingMarqueeGesture {
  kind: 'pending-marquee';
  start: InteractionPoint;
  baseSelection: number[];
  additive: boolean;
}

interface MarqueeGesture {
  kind: 'marquee';
  start: InteractionPoint;
  baseSelection: number[];
  additive: boolean;
}

interface MoveGesture {
  kind: 'move';
  start: InteractionPoint;
  grabbedId: number;
  origins: Map<number, EditorNote>;
  duplicate: boolean;
}

interface ResizeGesture {
  kind: 'resize';
  edge: 'start' | 'end';
  start: InteractionPoint;
  grabbedId: number;
  origins: Map<number, EditorNote>;
}

type Gesture =
  | { kind: 'none' }
  | PendingNoteGesture
  | PendingMarqueeGesture
  | MarqueeGesture
  | MoveGesture
  | ResizeGesture;

/** Rounds a PPQ position to the nearest multiple of `step`, clamped to >= 0. */
function snapToStep(ppq: number, step: number): number {
  if (!(step > 0)) return Math.max(0, ppq);
  return Math.max(0, Math.round(ppq / step) * step);
}

/** Projects editor notes into the string-id rectangles the hit-test consumes. */
function toRects(notes: ReadonlyArray<EditorNote>): NoteRect[] {
  return notes.map((note) => ({
    id: String(note.id),
    startPpq: note.startPpq,
    durationPpq: note.durationPpq,
    pitch: note.pitch,
  }));
}

/** Appends ids not already present, preserving base order. */
function unionIds(base: ReadonlyArray<number>, extra: ReadonlyArray<number>): number[] {
  const seen = new Set(base);
  const out = [...base];
  for (const id of extra) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Creates the smart-select interaction state machine for one note grid.
 *
 * @param options - View mapping, state accessors and mutation commands.
 * @returns Reactive gesture state plus pointer/keyboard handlers.
 */
export function useNoteInteractions(options: UseNoteInteractionsOptions): NoteInteractions {
  const { view, commands } = options;
  const threshold = options.dragThresholdPx ?? DEFAULT_DRAG_THRESHOLD_PX;
  const minDuration = options.minDurationPpq ?? DEFAULT_MIN_DURATION_PPQ;

  const marquee = ref<MarqueeRect | null>(null);
  const previewNotes = ref<EditorNote[] | null>(null);
  const cursor = ref<InteractionCursor>('default');

  let gesture: Gesture = { kind: 'none' };

  function hitOptions(): { resizeTolerancePx?: number } {
    return options.resizeTolerancePx === undefined
      ? {}
      : { resizeTolerancePx: options.resizeTolerancePx };
  }

  /** Captures clones of the gesture targets keyed by id (drag reference values). */
  function captureOrigins(targetIds: ReadonlyArray<number>): Map<number, EditorNote> {
    const byId = new Map(options.getNotes().map((note) => [note.id, note]));
    const origins = new Map<number, EditorNote>();
    for (const id of targetIds) {
      const note = byId.get(id);
      if (note) origins.set(id, { ...note });
    }
    return origins;
  }

  /**
   * Computes the shared move displacement: the grabbed note is snapped to the
   * grid (unless bypassed) and the resulting delta is applied uniformly so
   * relative spacing within the selection is preserved; the delta is clamped
   * so every note stays at startPpq >= 0 and pitch within 0..127.
   */
  function moveDeltas(
    g: MoveGesture,
    point: InteractionPoint,
    modifiers: InteractionModifiers,
  ): MoveDeltas {
    const grabbed = g.origins.get(g.grabbedId);
    if (!grabbed) return { deltaPpq: 0, deltaPitch: 0 };
    const bypass = modifiers.meta === true;
    const step = options.getGridPpq();
    const rawDelta = view.xToPpq(point.x) - view.xToPpq(g.start.x);
    const targetStart = bypass
      ? Math.max(0, grabbed.startPpq + rawDelta)
      : snapToStep(grabbed.startPpq + rawDelta, step);
    let deltaPpq = targetStart - grabbed.startPpq;
    let minStart = Number.POSITIVE_INFINITY;
    let minPitch = Number.POSITIVE_INFINITY;
    let maxPitch = Number.NEGATIVE_INFINITY;
    for (const origin of g.origins.values()) {
      minStart = Math.min(minStart, origin.startPpq);
      minPitch = Math.min(minPitch, origin.pitch);
      maxPitch = Math.max(maxPitch, origin.pitch);
    }
    if (minStart + deltaPpq < 0) deltaPpq = -minStart;
    let deltaPitch = Math.round((g.start.y - point.y) / view.rowHeight);
    deltaPitch = Math.min(MAX_PITCH - maxPitch, Math.max(MIN_PITCH - minPitch, deltaPitch));
    return { deltaPpq, deltaPitch };
  }

  /**
   * Computes the shared resize displacement for the dragged edge, snapped on
   * the grabbed note and clamped so every target keeps a positive duration
   * and a non-negative start.
   */
  function resizeDelta(
    g: ResizeGesture,
    point: InteractionPoint,
    modifiers: InteractionModifiers,
  ): number {
    const grabbed = g.origins.get(g.grabbedId);
    if (!grabbed) return 0;
    const bypass = modifiers.meta === true;
    const step = options.getGridPpq();
    const rawDelta = view.xToPpq(point.x) - view.xToPpq(g.start.x);
    if (g.edge === 'end') {
      const end = grabbed.startPpq + grabbed.durationPpq;
      const targetEnd = bypass ? end + rawDelta : snapToStep(end + rawDelta, step);
      let delta = targetEnd - end;
      for (const origin of g.origins.values()) {
        delta = Math.max(delta, minDuration - origin.durationPpq);
      }
      return delta;
    }
    const targetStart = bypass
      ? Math.max(0, grabbed.startPpq + rawDelta)
      : snapToStep(grabbed.startPpq + rawDelta, step);
    let delta = targetStart - grabbed.startPpq;
    for (const origin of g.origins.values()) {
      delta = Math.max(delta, -origin.startPpq);
      delta = Math.min(delta, origin.durationPpq - minDuration);
    }
    return delta;
  }

  /** Applies a resize delta to one origin note, returning its new extent. */
  function resizedExtent(
    edge: 'start' | 'end',
    origin: EditorNote,
    delta: number,
  ): { startPpq: number; durationPpq: number } {
    if (edge === 'end') {
      return {
        startPpq: origin.startPpq,
        durationPpq: Math.max(minDuration, origin.durationPpq + delta),
      };
    }
    return { startPpq: origin.startPpq + delta, durationPpq: origin.durationPpq - delta };
  }

  /** Builds the rendered note list for an in-flight move/duplicate gesture. */
  function buildMovePreview(g: MoveGesture, deltas: MoveDeltas): EditorNote[] {
    const all = options.getNotes().map((note) => ({ ...note }));
    if (g.duplicate) {
      // Duplicate copies get negative placeholder ids so renderers can treat
      // them as selected without clashing with real (positive) note ids.
      let placeholder = -1;
      const copies = [...g.origins.values()].map((origin) => ({
        ...origin,
        id: placeholder--,
        startPpq: origin.startPpq + deltas.deltaPpq,
        pitch: origin.pitch + deltas.deltaPitch,
      }));
      return [...all, ...copies];
    }
    return all.map((note) => {
      const origin = g.origins.get(note.id);
      return origin
        ? {
            ...note,
            startPpq: origin.startPpq + deltas.deltaPpq,
            pitch: origin.pitch + deltas.deltaPitch,
          }
        : note;
    });
  }

  /** Builds the rendered note list for an in-flight resize gesture. */
  function buildResizePreview(g: ResizeGesture, delta: number): EditorNote[] {
    return options.getNotes().map((note) => {
      const origin = g.origins.get(note.id);
      return origin ? { ...note, ...resizedExtent(g.edge, origin, delta) } : { ...note };
    });
  }

  /** Updates the live marquee rect and selection while a marquee drag runs. */
  function updateMarquee(g: MarqueeGesture, point: InteractionPoint): void {
    const rect: MarqueeRect = {
      x: g.start.x,
      y: g.start.y,
      width: point.x - g.start.x,
      height: point.y - g.start.y,
    };
    marquee.value = rect;
    const ids = marqueeSelect(toRects(options.getNotes()), rect, view).map(Number);
    commands.setSelection(g.additive ? unionIds(g.baseSelection, ids) : ids);
  }

  function onPointerDown(point: InteractionPoint, modifiers: InteractionModifiers = {}): void {
    const notes = options.getNotes();
    const hit = hitTestNote(toRects(notes), point, view, hitOptions());
    if (!hit) {
      gesture = {
        kind: 'pending-marquee',
        start: point,
        baseSelection: modifiers.shift ? [...options.getSelection()] : [],
        additive: modifiers.shift === true,
      };
      return;
    }
    const id = Number(hit.id);
    const wasSelected = options.getSelection().has(id);
    if (modifiers.shift) {
      if (!wasSelected) commands.setSelection([...options.getSelection(), id]);
    } else if (!wasSelected) {
      commands.setSelection([id]);
    }
    gesture = {
      kind: 'pending-note',
      start: point,
      noteId: id,
      zone: hit.zone,
      targetIds: [...options.getSelection()],
      wasSelected,
      shift: modifiers.shift === true,
      duplicate: modifiers.alt === true,
    };
  }

  /** Promotes a pending press into a drag gesture once the threshold is passed. */
  function promotePending(pending: PendingNoteGesture | PendingMarqueeGesture): Gesture {
    if (pending.kind === 'pending-note') {
      const origins = captureOrigins(pending.targetIds);
      if (origins.size === 0) return { kind: 'none' };
      if (pending.zone === 'body') {
        cursor.value = 'move';
        return {
          kind: 'move',
          start: pending.start,
          grabbedId: pending.noteId,
          origins,
          duplicate: pending.duplicate,
        };
      }
      cursor.value = 'ew-resize';
      return {
        kind: 'resize',
        edge: pending.zone === 'resize-start' ? 'start' : 'end',
        start: pending.start,
        grabbedId: pending.noteId,
        origins,
      };
    }
    cursor.value = 'crosshair';
    return {
      kind: 'marquee',
      start: pending.start,
      baseSelection: pending.baseSelection,
      additive: pending.additive,
    };
  }

  function onPointerMove(point: InteractionPoint, modifiers: InteractionModifiers = {}): void {
    if (gesture.kind === 'none') {
      const hit = hitTestNote(toRects(options.getNotes()), point, view, hitOptions());
      cursor.value = hit ? (hit.zone === 'body' ? 'pointer' : 'ew-resize') : 'default';
      return;
    }
    if (gesture.kind === 'pending-note' || gesture.kind === 'pending-marquee') {
      if (Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) < threshold) return;
      gesture = promotePending(gesture);
      if (gesture.kind === 'none') return;
    }
    if (gesture.kind === 'move') {
      previewNotes.value = buildMovePreview(gesture, moveDeltas(gesture, point, modifiers));
      return;
    }
    if (gesture.kind === 'resize') {
      previewNotes.value = buildResizePreview(gesture, resizeDelta(gesture, point, modifiers));
      return;
    }
    if (gesture.kind === 'marquee') {
      updateMarquee(gesture, point);
    }
  }

  function onPointerUp(point: InteractionPoint, modifiers: InteractionModifiers = {}): void {
    const g = gesture;
    gesture = { kind: 'none' };
    marquee.value = null;
    previewNotes.value = null;
    cursor.value = 'default';
    if (g.kind === 'pending-note') {
      // Plain click: shift toggles the note off when it was already selected;
      // without shift a click collapses a multi-selection to the clicked note.
      if (g.shift && g.wasSelected) {
        commands.setSelection([...options.getSelection()].filter((id) => id !== g.noteId));
      } else if (!g.shift && g.wasSelected) {
        commands.setSelection([g.noteId]);
      }
      return;
    }
    if (g.kind === 'pending-marquee') {
      if (!g.additive) commands.setSelection([]);
      return;
    }
    if (g.kind === 'move') {
      const deltas = moveDeltas(g, point, modifiers);
      if (deltas.deltaPpq === 0 && deltas.deltaPitch === 0) return;
      if (g.duplicate) {
        const newIds = [...g.origins.values()].map((origin) => {
          const input: NewEditorNote = {
            pitch: origin.pitch + deltas.deltaPitch,
            startPpq: origin.startPpq + deltas.deltaPpq,
            durationPpq: origin.durationPpq,
            velocity: origin.velocity,
            channel: origin.channel,
          };
          if (origin.offVelocity !== undefined) input.offVelocity = origin.offVelocity;
          return commands.addNote(input);
        });
        commands.setSelection(newIds);
        return;
      }
      commands.updateNotes(
        [...g.origins.values()].map((origin) => ({
          id: origin.id,
          startPpq: origin.startPpq + deltas.deltaPpq,
          pitch: origin.pitch + deltas.deltaPitch,
        })),
      );
      return;
    }
    if (g.kind === 'resize') {
      const delta = resizeDelta(g, point, modifiers);
      if (delta === 0) return;
      commands.updateNotes(
        [...g.origins.values()].map((origin) => {
          const extent = resizedExtent(g.edge, origin, delta);
          return g.edge === 'end'
            ? { id: origin.id, durationPpq: extent.durationPpq }
            : { id: origin.id, startPpq: extent.startPpq, durationPpq: extent.durationPpq };
        }),
      );
    }
    // Marquee selection was applied live during the drag; nothing to commit.
  }

  function onDoubleClick(point: InteractionPoint, modifiers: InteractionModifiers = {}): void {
    const notes = options.getNotes();
    if (hitTestNote(toRects(notes), point, view, hitOptions())) return;
    const step = options.getGridPpq();
    const ppq = view.xToPpq(point.x);
    // Snap to the grid cell containing the click (floor), so the note starts
    // where the user clicked rather than rounding to the next line.
    const startPpq =
      modifiers.meta === true || !(step > 0)
        ? Math.max(0, ppq)
        : Math.max(0, Math.floor(ppq / step) * step);
    const durationPpq = step > 0 ? step : DEFAULT_MIN_DURATION_PPQ;
    const id = commands.addNote({ pitch: view.yToPitch(point.y), startPpq, durationPpq });
    commands.setSelection([id]);
  }

  function cancel(): void {
    gesture = { kind: 'none' };
    marquee.value = null;
    previewNotes.value = null;
    cursor.value = 'default';
  }

  function onKeyDown(key: string): boolean {
    if (key === 'Escape') {
      if (gesture.kind === 'none') return false;
      cancel();
      return true;
    }
    if (key === 'Backspace' || key === 'Delete') {
      const selection = options.getSelection();
      if (selection.size === 0) return false;
      commands.deleteNotes([...selection]);
      return true;
    }
    return false;
  }

  return {
    marquee,
    previewNotes,
    cursor,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClick,
    onKeyDown,
    cancel,
  };
}
