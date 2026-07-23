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
import { MAX_PITCH, MIN_PITCH, snapPpqToStep } from '@/ui/canvas/timeline-range';
import type { EditorToolId } from '@/ui/editor/tools';

/** Px a pointer must travel from its down point before a drag gesture starts. */
export const DEFAULT_DRAG_THRESHOLD_PX = 3;

/** Smallest note duration a resize can produce (a sixty-fourth note in PPQ). */
export const DEFAULT_MIN_DURATION_PPQ = 0.0625;

/** Velocity given to notes created with the draw tool. */
export const DEFAULT_DRAW_VELOCITY = 96;

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
  /** Bulk insertion seam used by multi-note duplicate gestures. */
  addNotes?(inputs: ReadonlyArray<NewEditorNote>): number[];
  updateNotes(updates: ReadonlyArray<EditorNoteUpdate>): void;
  deleteNotes(ids: Iterable<number>): void;
  setSelection(ids: Iterable<number>): void;
  /**
   * Splits a note at a PPQ position as one undoable edit, returning the new
   * right-hand note id. Required by the split tool; absent = split is a no-op.
   */
  splitNote?(noteId: number, splitPpq: number): number;
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
  /** Returns the active editor tool (absent = always the select tool). */
  getTool?(): EditorToolId;
  /** True when note selection/audition is allowed but content mutation is blocked. */
  isReadOnly?(): boolean;
  /** Returns the editable clip length in PPQ; absent means no right-edge clamp. */
  getMaxPpq?(): number;
  /** Returns the editable source-window left edge; absent means zero. */
  getMinPpq?(): number;
  /** Optionally maps a raw pointer pitch to the pitch that should be created. */
  resolveCreatedPitch?(pitch: number): number;
  /** Optionally maps a moved note pitch to the pitch that should be committed. */
  resolveEditedPitch?(pitch: number): number;
  /**
   * Optional velocity resolver for newly drawn notes. When omitted, drawing
   * inherits the selected note velocity, then the latest note velocity, and
   * finally falls back to {@link DEFAULT_DRAW_VELOCITY}.
   */
  getDrawVelocity?(): number;
  /** Mutation commands invoked when gestures commit. */
  commands: InteractionCommands;
  /** Drag start threshold in px. Default {@link DEFAULT_DRAG_THRESHOLD_PX}. */
  dragThresholdPx?: number;
  /** Minimum note duration kept by resize, in PPQ. Default {@link DEFAULT_MIN_DURATION_PPQ}. */
  minDurationPpq?: number;
  /** Px distance from a note edge treated as a resize handle. */
  resizeTolerancePx?: number;
  /**
   * Optional audible-feedback hook. Called with a note's pitch and velocity
   * when the user clicks an existing note or creates a new one, so the host can
   * play a short preview through the active track's instrument. Omit for no
   * audition (e.g. in unit tests).
   */
  onAudition?(pitch: number, velocity: number): void;
  /** Audition the destination pitch while a move drag crosses pitch rows. */
  auditionDuringDrag?: boolean | (() => boolean);
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
  /** Floating readout shown during draw/move/resize/erase gestures. */
  gestureReadout: Ref<{ text: string; x: number; y: number } | null>;
  /** Handles pointerdown on the note grid (point in local px). */
  onPointerDown(point: InteractionPoint, modifiers?: InteractionModifiers): void;
  /** Handles pointermove (both hover feedback and drag updates). */
  onPointerMove(point: InteractionPoint, modifiers?: InteractionModifiers): void;
  /** Handles pointerup; commits the gesture through the commands. */
  onPointerUp(point: InteractionPoint, modifiers?: InteractionModifiers): void;
  /** Handles double-click; creates a snapped note on empty space. */
  onDoubleClick(point: InteractionPoint, modifiers?: InteractionModifiers): void;
  /** Returns the topmost note id under a point, or null when none is hit. */
  hitNoteAt(point: InteractionPoint): number | null;
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

/** Draw-tool gesture: a new note grows from its start to the pointer. */
interface DrawNoteGesture {
  kind: 'draw-note';
  start: InteractionPoint;
  startPpq: number;
  pitch: number;
}

/** Erase-tool gesture: notes the pointer sweeps over are removed on release. */
interface EraseGesture {
  kind: 'erase';
  ids: Set<number>;
}

type Gesture =
  | { kind: 'none' }
  | PendingNoteGesture
  | PendingMarqueeGesture
  | MarqueeGesture
  | MoveGesture
  | ResizeGesture
  | DrawNoteGesture
  | EraseGesture;

/** Snaps a displacement without clamping negative movement to the clip origin. */
function snapDeltaToStep(deltaPpq: number, step: number): number {
  return step > 0 ? Math.round(deltaPpq / step) * step : deltaPpq;
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
  const gestureReadout = ref<{ text: string; x: number; y: number } | null>(null);

  let gesture: Gesture = { kind: 'none' };
  let lastDragAuditionPitch: number | null = null;

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

  /** The active tool ('select' when no tool getter is wired). */
  function currentTool(): EditorToolId {
    return options.getTool?.() ?? 'select';
  }

  /** Clamps a pitch into the playable range. */
  function clampPitch(pitch: number): number {
    return Math.min(MAX_PITCH, Math.max(MIN_PITCH, pitch));
  }

  function createdPitch(point: InteractionPoint): number {
    return clampPitch(
      options.resolveCreatedPitch?.(view.yToPitch(point.y)) ?? view.yToPitch(point.y),
    );
  }

  function editedPitch(pitch: number): number {
    return clampPitch(options.resolveEditedPitch?.(pitch) ?? pitch);
  }

  function clampPpq(ppq: number): number {
    const rawMin = options.getMinPpq?.();
    const min = rawMin !== undefined && Number.isFinite(rawMin) ? rawMin : 0;
    const max = options.getMaxPpq?.();
    return max !== undefined && Number.isFinite(max)
      ? Math.min(Math.max(min, max), Math.max(min, ppq))
      : Math.max(min, ppq);
  }

  function clampStartPpq(ppq: number): number {
    const rawMin = options.getMinPpq?.();
    const min = rawMin !== undefined && Number.isFinite(rawMin) ? rawMin : 0;
    const max = options.getMaxPpq?.();
    const end =
      max !== undefined && Number.isFinite(max) ? max - minDuration : Number.POSITIVE_INFINITY;
    return Math.max(min, Math.min(end, clampPpq(ppq)));
  }

  function formatPpq(value: number): string {
    return String(Math.round(value * 1000) / 1000);
  }

  function setReadout(point: InteractionPoint, text: string): void {
    gestureReadout.value = { text, x: point.x + 12, y: point.y - 12 };
  }

  function shouldAuditionDuringDrag(): boolean {
    return typeof options.auditionDuringDrag === 'function'
      ? options.auditionDuringDrag()
      : options.auditionDuringDrag === true;
  }

  function clampVelocity(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_DRAW_VELOCITY;
    return Math.max(1, Math.min(127, Math.round(value)));
  }

  /** Velocity assigned to a newly drawn note. */
  function drawVelocity(): number {
    if (options.getDrawVelocity) return clampVelocity(options.getDrawVelocity());
    const notes = options.getNotes();
    const selection = options.getSelection();
    for (let i = notes.length - 1; i >= 0; i--) {
      if (selection.has(notes[i].id)) return clampVelocity(notes[i].velocity);
    }
    const latest = notes[notes.length - 1];
    return latest ? clampVelocity(latest.velocity) : DEFAULT_DRAW_VELOCITY;
  }

  /** Resolves the grid-snapped start cell of a draw at the pointer x. */
  function drawStartPpq(point: InteractionPoint, modifiers: InteractionModifiers): number {
    const step = options.getGridPpq();
    const ppq = view.xToPpq(point.x);
    const minLen = step > 0 ? step : DEFAULT_MIN_DURATION_PPQ;
    const snapped = modifiers.meta === true || !(step > 0) ? ppq : Math.floor(ppq / step) * step;
    const rawMin = options.getMinPpq?.();
    const min = rawMin !== undefined && Number.isFinite(rawMin) ? rawMin : 0;
    const rawMax = options.getMaxPpq?.();
    const max = rawMax !== undefined && Number.isFinite(rawMax) ? rawMax : Number.POSITIVE_INFINITY;
    return Math.max(min, Math.min(max - minLen, snapped));
  }

  /** Resolves the snapped length of an in-flight draw, kept at >= one grid cell. */
  function drawLength(
    g: DrawNoteGesture,
    point: InteractionPoint,
    modifiers: InteractionModifiers,
  ): number {
    const step = options.getGridPpq();
    const minLen = step > 0 ? step : DEFAULT_MIN_DURATION_PPQ;
    const raw = view.xToPpq(point.x);
    const end = modifiers.meta === true ? raw : snapPpqToStep(raw, step);
    const max = options.getMaxPpq?.();
    const maxEnd = max !== undefined && Number.isFinite(max) ? max : Number.POSITIVE_INFINITY;
    return Math.min(maxEnd - g.startPpq, Math.max(minLen, clampPpq(end) - g.startPpq));
  }

  /** Builds the rendered note list for an in-flight draw (draft note id -1). */
  function buildDrawPreview(
    g: DrawNoteGesture,
    point: InteractionPoint,
    modifiers: InteractionModifiers,
  ): EditorNote[] {
    const draft: EditorNote = {
      id: -1,
      pitch: g.pitch,
      velocity: drawVelocity(),
      startPpq: g.startPpq,
      durationPpq: drawLength(g, point, modifiers),
      channel: 0,
    };
    return [...options.getNotes().map((note) => ({ ...note })), draft];
  }

  /** Builds the rendered note list with the erase-marked notes removed. */
  function buildErasePreview(ids: ReadonlySet<number>): EditorNote[] {
    return options
      .getNotes()
      .filter((note) => !ids.has(note.id))
      .map((note) => ({ ...note }));
  }

  /** Hover cursor for a non-select tool. */
  function toolCursor(tool: EditorToolId): InteractionCursor {
    return tool === 'erase' ? 'default' : 'crosshair';
  }

  /** Splits the note under the pointer at the snapped pointer position. */
  function splitAt(point: InteractionPoint, modifiers: InteractionModifiers): void {
    const split = commands.splitNote;
    if (!split) return;
    const hit = hitTestNote(toRects(options.getNotes()), point, view, hitOptions());
    if (!hit) return;
    const note = options.getNotes().find((n) => n.id === Number(hit.id));
    if (!note) return;
    const step = options.getGridPpq();
    const raw = view.xToPpq(point.x);
    const splitPpq = modifiers.meta === true ? raw : snapPpqToStep(raw, step);
    if (splitPpq <= note.startPpq || splitPpq >= note.startPpq + note.durationPpq) return;
    const newId = split(note.id, splitPpq);
    commands.setSelection([newId]);
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
      ? clampStartPpq(grabbed.startPpq + rawDelta)
      : clampStartPpq(grabbed.startPpq + snapDeltaToStep(rawDelta, step));
    let deltaPpq = targetStart - grabbed.startPpq;
    let minStart = Number.POSITIVE_INFINITY;
    let minPitch = Number.POSITIVE_INFINITY;
    let maxPitch = Number.NEGATIVE_INFINITY;
    for (const origin of g.origins.values()) {
      minStart = Math.min(minStart, origin.startPpq);
      minPitch = Math.min(minPitch, origin.pitch);
      maxPitch = Math.max(maxPitch, origin.pitch);
    }
    const rawMinPpq = options.getMinPpq?.();
    const minPpq = rawMinPpq !== undefined && Number.isFinite(rawMinPpq) ? rawMinPpq : 0;
    if (minStart + deltaPpq < minPpq) deltaPpq = minPpq - minStart;
    const max = options.getMaxPpq?.();
    if (max !== undefined && Number.isFinite(max)) {
      let maxEnd = Number.NEGATIVE_INFINITY;
      for (const origin of g.origins.values())
        maxEnd = Math.max(maxEnd, origin.startPpq + origin.durationPpq);
      if (maxEnd + deltaPpq > max) deltaPpq = max - maxEnd;
    }
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
      const targetEnd = clampPpq(bypass ? end + rawDelta : snapPpqToStep(end + rawDelta, step));
      let delta = targetEnd - end;
      for (const origin of g.origins.values()) {
        delta = Math.max(delta, minDuration - origin.durationPpq);
      }
      const max = options.getMaxPpq?.();
      if (max !== undefined && Number.isFinite(max)) {
        let maxEnd = Number.NEGATIVE_INFINITY;
        for (const origin of g.origins.values()) {
          maxEnd = Math.max(maxEnd, origin.startPpq + origin.durationPpq);
        }
        if (maxEnd + delta > max) delta = max - maxEnd;
      }
      return delta;
    }
    const targetStart = bypass
      ? clampPpq(grabbed.startPpq + rawDelta)
      : clampPpq(snapPpqToStep(grabbed.startPpq + rawDelta, step));
    let delta = targetStart - grabbed.startPpq;
    const rawMinPpq = options.getMinPpq?.();
    const minPpq = rawMinPpq !== undefined && Number.isFinite(rawMinPpq) ? rawMinPpq : 0;
    for (const origin of g.origins.values()) {
      delta = Math.max(delta, minPpq - origin.startPpq);
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
        pitch: editedPitch(origin.pitch + deltas.deltaPitch),
      }));
      return [...all, ...copies];
    }
    return all.map((note) => {
      const origin = g.origins.get(note.id);
      return origin
        ? {
            ...note,
            startPpq: origin.startPpq + deltas.deltaPpq,
            pitch: editedPitch(origin.pitch + deltas.deltaPitch),
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
    if (options.isReadOnly?.() === true) {
      const hit = hitTestNote(toRects(options.getNotes()), point, view, hitOptions());
      if (hit) commands.setSelection([Number(hit.id)]);
      gesture = { kind: 'none' };
      return;
    }
    const tool = currentTool();
    if (tool === 'draw') {
      const pitch = createdPitch(point);
      gesture = {
        kind: 'draw-note',
        start: point,
        startPpq: drawStartPpq(point, modifiers),
        pitch,
      };
      previewNotes.value = buildDrawPreview(gesture, point, modifiers);
      setReadout(point, `Draw ${formatPpq(drawLength(gesture, point, modifiers))} ppq`);
      options.onAudition?.(pitch, drawVelocity());
      lastDragAuditionPitch = pitch;
      return;
    }
    if (tool === 'erase') {
      const ids = new Set<number>();
      const eraseHit = hitTestNote(toRects(options.getNotes()), point, view, hitOptions());
      if (eraseHit) ids.add(Number(eraseHit.id));
      gesture = { kind: 'erase', ids };
      previewNotes.value = buildErasePreview(ids);
      if (ids.size > 0) setReadout(point, `Erase ${ids.size}`);
      return;
    }
    if (tool === 'split') {
      splitAt(point, modifiers);
      gesture = { kind: 'none' };
      return;
    }
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
    const hitNote = notes.find((note) => note.id === id);
    if (hitNote) options.onAudition?.(hitNote.pitch, hitNote.velocity);
    lastDragAuditionPitch = hitNote?.pitch ?? null;
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
      if (options.isReadOnly?.() === true) {
        cursor.value = hitTestNote(toRects(options.getNotes()), point, view, hitOptions())
          ? 'pointer'
          : 'default';
        return;
      }
      const tool = currentTool();
      if (tool !== 'select') {
        cursor.value = toolCursor(tool);
        return;
      }
      const hit = hitTestNote(toRects(options.getNotes()), point, view, hitOptions());
      cursor.value = hit ? (hit.zone === 'body' ? 'pointer' : 'ew-resize') : 'default';
      return;
    }
    if (gesture.kind === 'draw-note') {
      previewNotes.value = buildDrawPreview(gesture, point, modifiers);
      setReadout(point, `Draw ${formatPpq(drawLength(gesture, point, modifiers))} ppq`);
      return;
    }
    if (gesture.kind === 'erase') {
      const hit = hitTestNote(toRects(options.getNotes()), point, view, hitOptions());
      if (hit) gesture.ids.add(Number(hit.id));
      previewNotes.value = buildErasePreview(gesture.ids);
      if (gesture.ids.size > 0) setReadout(point, `Erase ${gesture.ids.size}`);
      return;
    }
    if (gesture.kind === 'pending-note' || gesture.kind === 'pending-marquee') {
      if (Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) < threshold) return;
      gesture = promotePending(gesture);
      if (gesture.kind === 'none') return;
    }
    if (gesture.kind === 'move') {
      const deltas = moveDeltas(gesture, point, modifiers);
      previewNotes.value = buildMovePreview(gesture, deltas);
      const pitch =
        deltas.deltaPitch === 0
          ? '0 st'
          : `${deltas.deltaPitch > 0 ? '+' : ''}${deltas.deltaPitch} st`;
      const time =
        deltas.deltaPpq === 0
          ? '0 ppq'
          : `${deltas.deltaPpq > 0 ? '+' : ''}${formatPpq(deltas.deltaPpq)} ppq`;
      setReadout(point, `${gesture.duplicate ? 'Copy' : 'Move'} ${time}, ${pitch}`);
      if (shouldAuditionDuringDrag()) {
        const grabbed = gesture.origins.get(gesture.grabbedId);
        const nextPitch = grabbed ? editedPitch(grabbed.pitch + deltas.deltaPitch) : null;
        if (nextPitch !== null && nextPitch !== lastDragAuditionPitch) {
          lastDragAuditionPitch = nextPitch;
          options.onAudition?.(nextPitch, grabbed?.velocity ?? DEFAULT_DRAW_VELOCITY);
        }
      }
      return;
    }
    if (gesture.kind === 'resize') {
      const delta = resizeDelta(gesture, point, modifiers);
      previewNotes.value = buildResizePreview(gesture, delta);
      const grabbed = gesture.origins.get(gesture.grabbedId);
      const nextLength = grabbed
        ? resizedExtent(gesture.edge, grabbed, delta).durationPpq
        : DEFAULT_MIN_DURATION_PPQ;
      setReadout(point, `Length ${formatPpq(nextLength)} ppq`);
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
    gestureReadout.value = null;
    cursor.value = 'default';
    lastDragAuditionPitch = null;
    // Freeze can complete while a gesture is in flight. Keep selection-only
    // releases working, but never commit a stale content edit afterward.
    if (
      options.isReadOnly?.() === true &&
      g.kind !== 'pending-note' &&
      g.kind !== 'pending-marquee' &&
      g.kind !== 'marquee'
    )
      return;
    if (g.kind === 'draw-note') {
      const velocity = drawVelocity();
      const id = commands.addNote({
        pitch: g.pitch,
        startPpq: g.startPpq,
        durationPpq: drawLength(g, point, modifiers),
        ...(velocity === DEFAULT_DRAW_VELOCITY ? {} : { velocity }),
      });
      commands.setSelection([id]);
      return;
    }
    if (g.kind === 'erase') {
      if (g.ids.size > 0) commands.deleteNotes([...g.ids]);
      return;
    }
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
        const inputs = [...g.origins.values()].map((origin): NewEditorNote => {
          const input: NewEditorNote = {
            pitch: editedPitch(origin.pitch + deltas.deltaPitch),
            startPpq: origin.startPpq + deltas.deltaPpq,
            durationPpq: origin.durationPpq,
            velocity: origin.velocity,
            channel: origin.channel,
          };
          if (origin.offVelocity !== undefined) input.offVelocity = origin.offVelocity;
          return input;
        });
        const newIds = commands.addNotes
          ? commands.addNotes(inputs)
          : inputs.map((input) => commands.addNote(input));
        commands.setSelection(newIds);
        return;
      }
      commands.updateNotes(
        [...g.origins.values()].map((origin) => ({
          id: origin.id,
          startPpq: origin.startPpq + deltas.deltaPpq,
          pitch: editedPitch(origin.pitch + deltas.deltaPitch),
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
    if (options.isReadOnly?.() === true) return;
    const notes = options.getNotes();
    if (hitTestNote(toRects(notes), point, view, hitOptions())) return;
    const step = options.getGridPpq();
    // Snap to the grid cell containing the click (floor), so the note starts
    // where the user clicked rather than rounding to the next line.
    const startPpq = drawStartPpq(point, modifiers);
    const max = options.getMaxPpq?.();
    const durationPpq =
      max !== undefined && Number.isFinite(max)
        ? Math.min(
            step > 0 ? step : DEFAULT_MIN_DURATION_PPQ,
            Math.max(DEFAULT_MIN_DURATION_PPQ, max - startPpq),
          )
        : step > 0
          ? step
          : DEFAULT_MIN_DURATION_PPQ;
    const pitch = createdPitch(point);
    const velocity = drawVelocity();
    const id = commands.addNote({
      pitch,
      startPpq,
      durationPpq,
      ...(velocity === DEFAULT_DRAW_VELOCITY ? {} : { velocity }),
    });
    commands.setSelection([id]);
    options.onAudition?.(pitch, velocity);
  }

  /** Returns the topmost note id under a point, or null when none is hit. */
  function hitNoteAt(point: InteractionPoint): number | null {
    const hit = hitTestNote(toRects(options.getNotes()), point, view, hitOptions());
    return hit ? Number(hit.id) : null;
  }

  function cancel(): void {
    gesture = { kind: 'none' };
    marquee.value = null;
    previewNotes.value = null;
    gestureReadout.value = null;
    cursor.value = 'default';
    lastDragAuditionPitch = null;
  }

  function onKeyDown(key: string): boolean {
    if (key === 'Escape') {
      if (gesture.kind === 'none') return false;
      cancel();
      return true;
    }
    if (key === 'Backspace' || key === 'Delete') {
      if (options.isReadOnly?.() === true) return false;
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
    gestureReadout,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClick,
    hitNoteAt,
    onKeyDown,
    cancel,
  };
}
