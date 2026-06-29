import {
  allocateNoteId,
  getProject,
  getWasmModule,
  notesToProjectEvents,
  useProjectStore,
} from '../store';
import type { EditorNote, EditorNoteUpdate, NewEditorNote } from '../types';
import { cloneNotes, execute } from './history';

/** Default note-on velocity for newly created notes. */
const DEFAULT_VELOCITY = 96;
const MIN_DURATION_PPQ = 0.0625;

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

function selectedNotes(): EditorNote[] {
  const store = useProjectStore();
  return store.notes.filter((note) => store.selection.has(note.id));
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

/** Duplicates the selected notes by a PPQ offset as one undoable edit. */
export function duplicateSelection(deltaPpq: number): number[] {
  const store = useProjectStore();
  const selected = selectedNotes();
  if (selected.length === 0 || !Number.isFinite(deltaPpq)) return [];
  const copies = selected.map((note) => ({
    ...note,
    id: allocateNoteId(),
    startPpq: Math.max(0, note.startPpq + deltaPpq),
  }));
  commit([...cloneNotes(store.notes), ...copies]);
  setSelection(copies.map((note) => note.id));
  return copies.map((note) => note.id);
}

/** Repeats the selected notes `count` times at a fixed PPQ spacing. */
export function repeatSelection(count: number, stepPpq: number): number[] {
  const store = useProjectStore();
  const selected = selectedNotes();
  if (selected.length === 0 || count < 1 || !(stepPpq > 0)) return [];
  const copies: EditorNote[] = [];
  for (let i = 1; i <= Math.floor(count); i++) {
    for (const note of selected) {
      copies.push({ ...note, id: allocateNoteId(), startPpq: note.startPpq + stepPpq * i });
    }
  }
  commit([...cloneNotes(store.notes), ...copies]);
  setSelection(copies.map((note) => note.id));
  return copies.map((note) => note.id);
}

/** Extends selected notes to the next selected note on the same pitch/channel. */
export function legatoSelection(gapPpq = 0): void {
  const selected = selectedNotes().sort((a, b) => a.startPpq - b.startPpq);
  if (selected.length < 2) return;
  const byKey = new Map<string, EditorNote[]>();
  for (const note of selected) {
    const key = `${note.pitch}:${note.channel}`;
    byKey.set(key, [...(byKey.get(key) ?? []), note]);
  }
  const updates: EditorNoteUpdate[] = [];
  for (const group of byKey.values()) {
    group.sort((a, b) => a.startPpq - b.startPpq);
    for (let i = 0; i + 1 < group.length; i++) {
      const note = group[i];
      const next = group[i + 1];
      const durationPpq = Math.max(MIN_DURATION_PPQ, next.startPpq - note.startPpq - gapPpq);
      if (durationPpq !== note.durationPpq) updates.push({ id: note.id, durationPpq });
    }
  }
  updateNotes(updates);
}

/** Merges adjacent or overlapping selected notes with matching pitch/channel. */
export function mergeSelection(): void {
  const store = useProjectStore();
  const selectedIds = new Set(store.selection);
  const selected = selectedNotes().sort((a, b) => a.pitch - b.pitch || a.startPpq - b.startPpq);
  if (selected.length < 2) return;
  const keep = new Set<number>();
  const drop = new Set<number>();
  const merged = new Map<number, EditorNote>();
  for (const note of selected) {
    const lastId = [...keep]
      .map((id) => merged.get(id) ?? store.notes.find((n) => n.id === id))
      .findLast(
        (candidate) => candidate?.pitch === note.pitch && candidate.channel === note.channel,
      )?.id;
    const last =
      lastId !== undefined
        ? (merged.get(lastId) ?? store.notes.find((n) => n.id === lastId))
        : undefined;
    if (last && note.startPpq <= last.startPpq + last.durationPpq + 1e-9) {
      const end = Math.max(last.startPpq + last.durationPpq, note.startPpq + note.durationPpq);
      merged.set(last.id, { ...last, durationPpq: end - last.startPpq });
      drop.add(note.id);
    } else {
      keep.add(note.id);
      merged.set(note.id, { ...note });
    }
  }
  if (drop.size === 0) return;
  const next = store.notes
    .filter((note) => !drop.has(note.id))
    .map((note) => (selectedIds.has(note.id) ? (merged.get(note.id) ?? { ...note }) : { ...note }));
  commit(next);
  setSelection([...keep].filter((id) => !drop.has(id)));
}

/** Removes overlapping duplicate note tails by shortening or deleting overlaps. */
export function cleanupOverlaps(): void {
  const store = useProjectStore();
  const notes = cloneNotes(store.notes).sort(
    (a, b) => a.pitch - b.pitch || a.channel - b.channel || a.startPpq - b.startPpq,
  );
  const drop = new Set<number>();
  const updates = new Map<number, EditorNote>();
  const lastByKey = new Map<string, EditorNote>();
  for (const note of notes) {
    const key = `${note.pitch}:${note.channel}`;
    const prev = lastByKey.get(key);
    if (prev && note.startPpq < prev.startPpq + prev.durationPpq) {
      const nextDuration = note.startPpq - prev.startPpq;
      if (nextDuration < MIN_DURATION_PPQ) drop.add(prev.id);
      else updates.set(prev.id, { ...prev, durationPpq: nextDuration });
    }
    lastByKey.set(key, updates.get(note.id) ?? note);
  }
  if (drop.size === 0 && updates.size === 0) return;
  const next = store.notes
    .filter((note) => !drop.has(note.id))
    .map((note) => updates.get(note.id) ?? { ...note });
  commit(next);
  setSelection([...store.selection].filter((id) => !drop.has(id)));
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
 * Snaps the pitch of every selected note to the nearest note of the piano
 * roll's active scale (root + mode from the scale-highlight config) as one
 * undoable edit. The engine's `scaleQuantizeMidi` oracle does the pitch-class
 * snap, so the result matches scale highlighting exactly. A no-op when nothing
 * is selected, the mode mask is empty, or every note already sits in the scale.
 */
export function snapSelectionToScale(): void {
  const store = useProjectStore();
  if (store.selection.size === 0) return;
  const { rootPc, modeMask } = store.scaleHighlight;
  // An empty mask has no in-scale pitch class to snap to.
  if ((modeMask & 0xfff) === 0) return;
  const mod = getWasmModule();
  let changed = false;
  const next = store.notes.map((note) => {
    if (!store.selection.has(note.id)) return { ...note };
    const snapped = clampInt(mod.scaleQuantizeMidi(rootPc, modeMask, note.pitch), 0, 127);
    if (snapped === note.pitch) return { ...note };
    changed = true;
    return { ...note, pitch: snapped };
  });
  if (changed) commit(next);
}

/** Selects notes matching any pitch in the current selection. */
export function selectSamePitch(): void {
  const store = useProjectStore();
  const pitches = new Set(selectedNotes().map((note) => note.pitch));
  if (pitches.size === 0) return;
  setSelection(store.notes.filter((note) => pitches.has(note.pitch)).map((note) => note.id));
}

/** Selects notes matching any MIDI channel in the current selection. */
export function selectSameChannel(): void {
  const store = useProjectStore();
  const channels = new Set(selectedNotes().map((note) => note.channel));
  if (channels.size === 0) return;
  setSelection(store.notes.filter((note) => channels.has(note.channel)).map((note) => note.id));
}

/** Selects notes whose velocity lies inside the current selection's velocity range. */
export function selectVelocityRange(): void {
  const store = useProjectStore();
  const selected = selectedNotes();
  if (selected.length === 0) return;
  const min = Math.min(...selected.map((note) => note.velocity));
  const max = Math.max(...selected.map((note) => note.velocity));
  setSelection(
    store.notes
      .filter((note) => note.velocity >= min && note.velocity <= max)
      .map((note) => note.id),
  );
}

/** Selects notes outside the active highlighted scale. */
export function selectOutOfScale(): void {
  const store = useProjectStore();
  const mask = store.highlightedPitchClasses;
  if (!mask.some(Boolean)) return;
  setSelection(
    store.notes.filter((note) => !mask[((note.pitch % 12) + 12) % 12]).map((note) => note.id),
  );
}

/** Selects notes that overlap another note with the same pitch and channel. */
export function selectOverlaps(): void {
  const store = useProjectStore();
  const ids = new Set<number>();
  const byKey = new Map<string, EditorNote[]>();
  for (const note of store.notes) {
    const key = `${note.pitch}:${note.channel}`;
    byKey.set(key, [...(byKey.get(key) ?? []), note]);
  }
  for (const group of byKey.values()) {
    group.sort((a, b) => a.startPpq - b.startPpq);
    for (let i = 0; i + 1 < group.length; i++) {
      if (group[i].startPpq + group[i].durationPpq > group[i + 1].startPpq) {
        ids.add(group[i].id);
        ids.add(group[i + 1].id);
      }
    }
  }
  setSelection(ids);
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

/** Quantizes selected note ends to the snap grid as one undoable edit. */
export function quantizeSelectionEnds(strength = 1): void {
  const store = useProjectStore();
  if (store.selection.size === 0) return;
  const gridPpq = 4 / store.snapDivision;
  const updates: EditorNoteUpdate[] = [];
  for (const note of store.notes) {
    if (!store.selection.has(note.id)) continue;
    const end = note.startPpq + note.durationPpq;
    const target = Math.max(note.startPpq + MIN_DURATION_PPQ, Math.round(end / gridPpq) * gridPpq);
    const nextEnd = end + (target - end) * strength;
    const durationPpq = Math.max(MIN_DURATION_PPQ, nextEnd - note.startPpq);
    if (durationPpq !== note.durationPpq) updates.push({ id: note.id, durationPpq });
  }
  updateNotes(updates);
}

/** Normalizes selected velocities so the loudest selected note reaches target. */
export function normalizeSelectionVelocity(target = 100): void {
  const selected = selectedNotes();
  if (selected.length === 0) return;
  const max = Math.max(...selected.map((note) => note.velocity));
  if (max <= 0) return;
  const scale = clampInt(target, 1, 127) / max;
  updateNotes(
    selected.map((note) => ({
      id: note.id,
      velocity: clampInt(note.velocity * scale, 1, 127),
    })),
  );
}

/** Applies a linear velocity fade across selected notes ordered by start time. */
export function fadeSelectionVelocity(from = 40, to = 110): void {
  const selected = selectedNotes().sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch);
  if (selected.length === 0) return;
  const start = clampInt(from, 1, 127);
  const end = clampInt(to, 1, 127);
  updateNotes(
    selected.map((note, index) => {
      const t = selected.length <= 1 ? 1 : index / (selected.length - 1);
      return { id: note.id, velocity: clampInt(start + (end - start) * t, 1, 127) };
    }),
  );
}

/** Compresses or expands selected velocities around their average. */
export function scaleSelectionVelocityDynamics(amount: number): void {
  const selected = selectedNotes();
  if (selected.length === 0 || !Number.isFinite(amount)) return;
  const avg = selected.reduce((sum, note) => sum + note.velocity, 0) / selected.length;
  updateNotes(
    selected.map((note) => ({
      id: note.id,
      velocity: clampInt(avg + (note.velocity - avg) * amount, 1, 127),
    })),
  );
}

/** Moves selected notes one scale degree up or down using active scale classes. */
export function transposeSelectionDiatonic(steps: number): void {
  const store = useProjectStore();
  const selected = selectedNotes();
  const mask = store.highlightedPitchClasses;
  if (selected.length === 0 || !mask.some(Boolean) || !Number.isFinite(steps) || steps === 0) {
    return;
  }
  const dir = steps > 0 ? 1 : -1;
  const count = Math.abs(Math.trunc(steps));
  const updates: EditorNoteUpdate[] = [];
  for (const note of selected) {
    let pitch = note.pitch;
    for (let step = 0; step < count; step++) {
      let next = pitch + dir;
      while (next >= 0 && next <= 127 && !mask[((next % 12) + 12) % 12]) next += dir;
      pitch = Math.min(127, Math.max(0, next));
    }
    if (pitch !== note.pitch) updates.push({ id: note.id, pitch });
  }
  updateNotes(updates);
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
