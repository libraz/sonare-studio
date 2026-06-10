import type { ProjectMidiEvent } from '@/wasm/index.js';
import { allocateNoteId, getProject, getWasmModule, useProjectStore } from './store';
import type { EditorNote, EditorNoteUpdate, NewEditorNote } from './types';

/** Default note-on velocity for newly created notes. */
const DEFAULT_VELOCITY = 96;

/**
 * Maximum number of edits kept in the local id-snapshot history. When it
 * overflows, the oldest snapshot is dropped and undo stops there even though
 * the Project history may reach further back.
 */
const MAX_HISTORY = 100;

// Undo/redo state. Project.undo()/redo() fully cover setMidiEvents (it is an
// undoable edit on the project history), so the Project remains the source of
// truth for note content across undo. These parallel snapshots exist only to
// restore the editor-side note ids, which the Project does not store.
const undoSnapshots: EditorNote[][] = [];
const redoSnapshots: EditorNote[][] = [];

/** Deep-copies a note list into plain objects (detached from reactivity). */
function cloneNotes(notes: ReadonlyArray<EditorNote>): EditorNote[] {
  return notes.map((note) => ({ ...note }));
}

/** Throws RangeError when a note has out-of-range or non-finite fields. */
function validateNote(note: Omit<EditorNote, 'id'>): void {
  if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) {
    throw new RangeError(`Note pitch must be an integer in [0, 127], got ${note.pitch}`);
  }
  if (!Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127) {
    throw new RangeError(`Note velocity must be an integer in [1, 127], got ${note.velocity}`);
  }
  if (!Number.isInteger(note.channel) || note.channel < 0 || note.channel > 15) {
    throw new RangeError(`Note channel must be an integer in [0, 15], got ${note.channel}`);
  }
  if (!Number.isFinite(note.startPpq) || note.startPpq < 0) {
    throw new RangeError(`Note startPpq must be finite and >= 0, got ${note.startPpq}`);
  }
  if (!Number.isFinite(note.durationPpq) || note.durationPpq <= 0) {
    throw new RangeError(`Note durationPpq must be finite and > 0, got ${note.durationPpq}`);
  }
  if (
    note.offVelocity !== undefined &&
    (!Number.isInteger(note.offVelocity) || note.offVelocity < 1 || note.offVelocity > 127)
  ) {
    throw new RangeError(
      `Note offVelocity must be an integer in [1, 127], got ${note.offVelocity}`,
    );
  }
}

/** A note-on or note-off boundary used to build the flat event list. */
interface NoteBoundary {
  ppq: number;
  kind: 'on' | 'off';
  pitch: number;
  channel: number;
  velocity: number;
}

/**
 * Expands editor notes into a sorted flat event list for setMidiEvents.
 * Note-offs sort before note-ons at the same PPQ so a repeated pitch releases
 * before it retriggers.
 */
function notesToEvents(notes: ReadonlyArray<EditorNote>): ProjectMidiEvent[] {
  const wasm = getWasmModule();
  const boundaries: NoteBoundary[] = [];
  for (const note of notes) {
    boundaries.push({
      ppq: note.startPpq,
      kind: 'on',
      pitch: note.pitch,
      channel: note.channel,
      velocity: note.velocity,
    });
    boundaries.push({
      ppq: note.startPpq + note.durationPpq,
      kind: 'off',
      pitch: note.pitch,
      channel: note.channel,
      velocity: note.offVelocity ?? 0,
    });
  }
  boundaries.sort(
    (a, b) =>
      a.ppq - b.ppq ||
      (a.kind === b.kind ? 0 : a.kind === 'off' ? -1 : 1) ||
      a.pitch - b.pitch ||
      a.channel - b.channel,
  );
  return boundaries.map((b) =>
    b.kind === 'on'
      ? wasm.Project.midiNoteOn(b.ppq, 0, b.channel, b.pitch, b.velocity)
      : wasm.Project.midiNoteOff(b.ppq, 0, b.channel, b.pitch, b.velocity),
  );
}

/**
 * Applies a new note list as one undoable edit: validates, snapshots the
 * current mirror for undo, replaces the clip's events in the Project
 * (setMidiEvents = one entry on the project history), then refreshes the
 * mirror from the Project using `nextNotes` as id hints.
 */
function commit(nextNotes: EditorNote[]): void {
  const store = useProjectStore();
  const project = getProject();
  for (const note of nextNotes) validateNote(note);
  undoSnapshots.push(cloneNotes(store.notes));
  if (undoSnapshots.length > MAX_HISTORY) undoSnapshots.shift();
  redoSnapshots.length = 0;
  project.setMidiEvents(store.clipId, notesToEvents(nextNotes));
  store.refresh(nextNotes);
}

/**
 * Adds a note to the edited clip.
 *
 * @param input Note fields; velocity defaults to 96 and channel to 0.
 * @returns The editor id assigned to the new note.
 */
export function addNote(input: NewEditorNote): number {
  const store = useProjectStore();
  const note: EditorNote = {
    id: allocateNoteId(),
    pitch: input.pitch,
    velocity: input.velocity ?? DEFAULT_VELOCITY,
    startPpq: input.startPpq,
    durationPpq: input.durationPpq,
    channel: input.channel ?? 0,
  };
  if (input.offVelocity !== undefined) note.offVelocity = input.offVelocity;
  commit([...cloneNotes(store.notes), note]);
  return note.id;
}

/**
 * Applies partial edits (move / resize / velocity / channel) to existing
 * notes as one undoable edit. Updates referencing unknown ids are ignored;
 * the call is a no-op when nothing matches.
 *
 * @param updates Per-note partial edits addressed by editor id.
 */
export function updateNotes(updates: ReadonlyArray<EditorNoteUpdate>): void {
  const store = useProjectStore();
  const byId = new Map(updates.map((update) => [update.id, update]));
  let changed = false;
  const next = store.notes.map((note) => {
    const update = byId.get(note.id);
    if (!update) return { ...note };
    changed = true;
    const merged: EditorNote = {
      ...note,
      pitch: update.pitch ?? note.pitch,
      velocity: update.velocity ?? note.velocity,
      startPpq: update.startPpq ?? note.startPpq,
      durationPpq: update.durationPpq ?? note.durationPpq,
      channel: update.channel ?? note.channel,
    };
    if (update.offVelocity !== undefined) merged.offVelocity = update.offVelocity;
    return merged;
  });
  if (!changed) return;
  commit(next);
}

/**
 * Deletes notes by editor id as one undoable edit. Unknown ids are ignored;
 * the call is a no-op when nothing matches.
 *
 * @param ids Editor ids of the notes to delete.
 */
export function deleteNotes(ids: Iterable<number>): void {
  const store = useProjectStore();
  const drop = new Set(ids);
  const next = store.notes.filter((note) => !drop.has(note.id)).map((note) => ({ ...note }));
  if (next.length === store.notes.length) return;
  commit(next);
}

/**
 * Replaces the selection. Ids without a matching note are dropped. Selection
 * is editor-only state: it does not touch the Project and is not undoable.
 *
 * @param ids Editor ids to select.
 */
export function setSelection(ids: Iterable<number>): void {
  const store = useProjectStore();
  const alive = new Set(store.notes.map((note) => note.id));
  store.selection = new Set([...ids].filter((id) => alive.has(id)));
}

/**
 * Snaps a PPQ position to a regular local grid with adjustable strength.
 *
 * @param ppq Position to snap.
 * @param gridPpq Grid step in PPQ (> 0).
 * @param strength 0..1 interpolation toward the grid line.
 * @returns The (partially) snapped position.
 */
function snapPpqToLocalGrid(ppq: number, gridPpq: number, strength: number): number {
  const target = Math.round(ppq / gridPpq) * gridPpq;
  return ppq + (target - ppq) * strength;
}

/**
 * Quantizes the start positions of the selected notes to the snap grid as one
 * undoable edit. Project.snapToGrid only snaps to the project's beat grid, so
 * it is used when the editor grid is exactly one beat (snapDivision = 4);
 * finer or coarser grids use equivalent local snap math.
 *
 * @param strength 0..1 interpolation toward the grid (default 1 = full snap).
 */
export function quantizeSelection(strength = 1): void {
  const store = useProjectStore();
  if (store.selection.size === 0) return;
  const project = getProject();
  const gridPpq = 4 / store.snapDivision;
  let changed = false;
  const next = store.notes.map((note) => {
    if (!store.selection.has(note.id)) return { ...note };
    const snapped =
      gridPpq === 1
        ? project.snapToGrid(note.startPpq, strength)
        : snapPpqToLocalGrid(note.startPpq, gridPpq, strength);
    if (snapped === note.startPpq) return { ...note };
    changed = true;
    return { ...note, startPpq: Math.max(0, snapped) };
  });
  if (changed) commit(next);
}

/**
 * Undoes the most recent editor command by delegating to Project.undo()
 * (setMidiEvents is on the project history) and restoring the matching
 * id-annotated snapshot so note ids and selection stay stable.
 *
 * @returns True when an edit was undone, false when the history was empty.
 */
export function undo(): boolean {
  const snapshot = undoSnapshots.pop();
  if (!snapshot) return false;
  const store = useProjectStore();
  redoSnapshots.push(cloneNotes(store.notes));
  getProject().undo();
  store.refresh(snapshot);
  return true;
}

/**
 * Redoes the most recently undone editor command by delegating to
 * Project.redo() and restoring the matching id-annotated snapshot.
 *
 * @returns True when an edit was redone, false when nothing was undone.
 */
export function redo(): boolean {
  const snapshot = redoSnapshots.pop();
  if (!snapshot) return false;
  const store = useProjectStore();
  undoSnapshots.push(cloneNotes(store.notes));
  getProject().redo();
  store.refresh(snapshot);
  return true;
}

/** True when at least one edit can be undone. */
export function canUndo(): boolean {
  return undoSnapshots.length > 0;
}

/** True when at least one undone edit can be redone. */
export function canRedo(): boolean {
  return redoSnapshots.length > 0;
}

/** Drops all local undo/redo snapshots; call alongside the store's dispose(). */
export function clearHistory(): void {
  undoSnapshots.length = 0;
  redoSnapshots.length = 0;
}
