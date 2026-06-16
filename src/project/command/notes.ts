import { allocateNoteId, getProject, notesToProjectEvents, useProjectStore } from '../store';
import type { EditorNote, EditorNoteUpdate, NewEditorNote } from '../types';
import { cloneNotes, execute } from './history';

/** Default note-on velocity for newly created notes. */
const DEFAULT_VELOCITY = 96;

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

/**
 * Applies a new note list to the active clip as one undoable edit: validates,
 * replaces the clip's events in the Project (setMidiEvents = one entry on the
 * project history), then refreshes the mirror using `nextNotes` as id hints.
 */
function commit(nextNotes: EditorNote[]): void {
  const store = useProjectStore();
  const project = getProject();
  if (store.clipId < 0) throw new Error('No active clip to edit');
  for (const note of nextNotes) validateNote(note);
  execute(1, () => {
    project.setMidiEvents(store.clipId, notesToProjectEvents(nextNotes));
    store.refresh(nextNotes);
  });
}

/**
 * Adds a note to the active clip.
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
 * Splits a note at a PPQ position as one undoable edit: the original note is
 * shortened to end at the split and a new note carries the remainder (same
 * pitch, velocity, channel and release velocity). The split must lie strictly
 * inside the note.
 *
 * @param noteId Editor id of the note to split.
 * @param splitPpq Split position in PPQ (start < splitPpq < end).
 * @returns The editor id of the new right-hand note.
 */
export function splitNote(noteId: number, splitPpq: number): number {
  const store = useProjectStore();
  const original = store.notes.find((note) => note.id === noteId);
  if (!original) throw new Error(`Unknown note id ${noteId}`);
  const end = original.startPpq + original.durationPpq;
  if (!Number.isFinite(splitPpq) || splitPpq <= original.startPpq || splitPpq >= end) {
    throw new RangeError(
      `Split position ${splitPpq} must lie strictly inside the note [${original.startPpq}, ${end}]`,
    );
  }
  const rightId = allocateNoteId();
  const right: EditorNote = {
    id: rightId,
    pitch: original.pitch,
    velocity: original.velocity,
    startPpq: splitPpq,
    durationPpq: end - splitPpq,
    channel: original.channel,
  };
  if (original.offVelocity !== undefined) right.offVelocity = original.offVelocity;
  const next = cloneNotes(store.notes).map((note) =>
    note.id === noteId ? { ...note, durationPpq: splitPpq - note.startPpq } : note,
  );
  next.push(right);
  commit(next);
  return rightId;
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

/** Clamps a value to an inclusive integer range. */
function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Transposes the selected notes by a number of semitones as one undoable edit.
 * Pitches are clamped to the MIDI range [0, 127]; the whole selection shifts
 * by the same amount only when every note stays in range, matching how a real
 * DAW refuses to fold notes past the keyboard edges.
 *
 * @param semitones Signed semitone offset (e.g. +12 = up an octave).
 */
export function transposeSelection(semitones: number): void {
  const store = useProjectStore();
  if (store.selection.size === 0 || !Number.isFinite(semitones) || semitones === 0) return;
  const step = Math.trunc(semitones);
  if (step === 0) return;
  // Clamp the shift so the whole block keeps its internal intervals: find the
  // most the selection can move before any note hits a boundary.
  let lowest = 127;
  let highest = 0;
  for (const note of store.notes) {
    if (!store.selection.has(note.id)) continue;
    lowest = Math.min(lowest, note.pitch);
    highest = Math.max(highest, note.pitch);
  }
  const applied = step > 0 ? Math.min(step, 127 - highest) : Math.max(step, -lowest);
  if (applied === 0) return;
  const next = store.notes.map((note) =>
    store.selection.has(note.id) ? { ...note, pitch: note.pitch + applied } : { ...note },
  );
  commit(next);
}

/**
 * Quantizes the lengths (durations) of the selected notes to the snap grid as
 * one undoable edit, complementing {@link quantizeSelection} which moves their
 * starts. Each duration snaps to the nearest grid multiple (never below one
 * grid step) with adjustable strength.
 *
 * @param strength 0..1 interpolation toward the grid (default 1 = full snap).
 */
export function quantizeSelectionLengths(strength = 1): void {
  const store = useProjectStore();
  if (store.selection.size === 0) return;
  const gridPpq = 4 / store.snapDivision;
  let changed = false;
  const next = store.notes.map((note) => {
    if (!store.selection.has(note.id)) return { ...note };
    const target = Math.max(gridPpq, Math.round(note.durationPpq / gridPpq) * gridPpq);
    const snapped = note.durationPpq + (target - note.durationPpq) * strength;
    const rounded = Math.max(1, Math.round(snapped));
    if (rounded === note.durationPpq) return { ...note };
    changed = true;
    return { ...note, durationPpq: rounded };
  });
  if (changed) commit(next);
}

/**
 * Adds a signed offset to the velocity of every selected note as one undoable
 * edit (clamped to [1, 127]). Used by the velocity nudge controls.
 *
 * @param delta Signed velocity offset.
 */
export function nudgeSelectionVelocity(delta: number): void {
  const store = useProjectStore();
  if (store.selection.size === 0 || !Number.isFinite(delta) || delta === 0) return;
  let changed = false;
  const next = store.notes.map((note) => {
    if (!store.selection.has(note.id)) return { ...note };
    const velocity = clampInt(note.velocity + delta, 1, 127);
    if (velocity === note.velocity) return { ...note };
    changed = true;
    return { ...note, velocity };
  });
  if (changed) commit(next);
}

/**
 * Randomizes the velocity of the selected notes within ±amount as one undoable
 * edit, clamped to [1, 127]. Adds natural variation to step-entered or
 * quantized parts ("humanize").
 *
 * @param amount Maximum absolute jitter applied per note (>= 1).
 * @param random Injectable RNG returning [0, 1) (defaults to Math.random) so
 *   tests stay deterministic.
 */
export function humanizeSelectionVelocity(
  amount: number,
  random: () => number = Math.random,
): void {
  const store = useProjectStore();
  if (store.selection.size === 0 || !Number.isFinite(amount) || amount < 1) return;
  const span = Math.round(amount);
  let changed = false;
  const next = store.notes.map((note) => {
    if (!store.selection.has(note.id)) return { ...note };
    const jitter = Math.round((random() * 2 - 1) * span);
    const velocity = clampInt(note.velocity + jitter, 1, 127);
    if (velocity === note.velocity) return { ...note };
    changed = true;
    return { ...note, velocity };
  });
  if (changed) commit(next);
}
