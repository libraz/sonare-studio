import { shallowRef } from 'vue';
import { tidyGridPpq, tidyNotes } from '@/compose/tidy-notes';
import { clamp01, clampInt } from '@/lib/math';
import {
  applyGrooveToPosition,
  DEFAULT_GROOVE_STEPS,
  extractGrooveTemplate,
  type GrooveTemplate,
} from '../groove';
import { audibleMidiSourceWindow, midiSourcePpqToTimeline } from '../midi-projection';
import {
  allocateNoteId,
  getProject,
  getWasmModule,
  notesToProjectEvents,
  useProjectStore,
} from '../store';
import { measureRangeAt, snapPpqToMeterGrid, snapPpqToSwingMeterGrid } from '../time-signature';
import {
  clipKind,
  type EditorClip,
  type EditorNote,
  type EditorNoteUpdate,
  type NewEditorNote,
} from '../types';
import { CLIP_LANE_EPSILON, laneGapAround } from './clip-lane';
import { cloneNotes, executeAtomic } from './history';
import { requireEditableClip, requireEditableTrack } from './utils';

/** Default note-on velocity for newly created notes. */
const DEFAULT_VELOCITY = 96;
const MIN_DURATION_PPQ = 0.0625;

/** Process-local note clipboard; entries stay detached from mutable store notes. */
let noteClipboard: Array<Omit<EditorNote, 'id'>> = [];
/** Bumped on every note copy so menus reading the clipboard stay reactive. */
export const noteClipboardVersion = shallowRef(0);

/** Returns whether copied notes are available to paste. */
export function hasCopiedNotes(): boolean {
  return noteClipboard.length > 0;
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

/** Clip-source PPQ a note in the clip may reach to: the clip grows up to the next clip on its track. */
export function noteEndLimitPpq(clip: EditorClip): number {
  if (clip.loopEnabled) return audibleMidiSourceWindow(clip).endPpq;
  const nextStart = nextClipStartPpq(clip);
  return nextStart === undefined
    ? Number.POSITIVE_INFINITY
    : nextStart - clip.startPpq + clip.sourceOffsetPpq;
}

function nextClipStartPpq(clip: EditorClip): number | undefined {
  const end = clip.startPpq + clip.lengthPpq;
  let next: number | undefined;
  for (const other of useProjectStore().clips) {
    if (other.id === clip.id || other.trackId !== clip.trackId) continue;
    if (
      other.startPpq >= end - CLIP_LANE_EPSILON &&
      (next === undefined || other.startPpq < next)
    ) {
      next = other.startPpq;
    }
  }
  return next;
}

/** Notes that are new or whose span differs from the same-id note in `previous`. */
function addedOrRespannedNotes(
  previous: readonly EditorNote[],
  next: readonly EditorNote[],
): EditorNote[] {
  const before = new Map(previous.map((note) => [note.id, note]));
  return next.filter((note) => {
    const old = before.get(note.id);
    return (
      old === undefined || old.startPpq !== note.startPpq || old.durationPpq !== note.durationPpq
    );
  });
}

/** Clip length reaching the bar holding the last note end; undefined when the clip already covers it. */
function grownClipLengthPpq(clip: EditorClip, notes: readonly EditorNote[]): number | undefined {
  if (clip.loopEnabled || notes.length === 0) return undefined;
  const lastEnd = Math.max(...notes.map((note) => note.startPpq + note.durationPpq));
  const endPpq = midiSourcePpqToTimeline(clip, lastEnd);
  if (endPpq <= clip.startPpq + clip.lengthPpq + CLIP_LANE_EPSILON) return undefined;
  const bar = measureRangeAt(useProjectStore().timeSignatures, endPpq - 1e-6);
  const nextStart = nextClipStartPpq(clip) ?? Number.POSITIVE_INFINITY;
  return Math.min(bar.startPpq + bar.lengthPpq, nextStart) - clip.startPpq;
}

/**
 * Applies a new note list and optional clip-window change as one undoable edit.
 * Without an explicit length, a non-looped clip grows to keep every note audible.
 */
function commit(
  nextNotes: EditorNote[],
  options: {
    writeNotes: boolean;
    resizeLengthPpq?: number;
    loop?: { enabled: boolean; lengthPpq?: number };
  },
): void {
  const store = useProjectStore();
  const project = getProject();
  if (store.clipId < 0) throw new Error('No active clip to edit');
  const clip = requireEditableClip(store, store.clipId);
  for (const note of nextNotes) validateNote(note);
  const resizeLengthPpq =
    options.resizeLengthPpq ??
    (options.writeNotes
      ? // Notes hidden past a trimmed end stay untouched, so only edited ones can regrow the clip.
        grownClipLengthPpq(clip, addedOrRespannedNotes(clip.notes, nextNotes))
      : undefined);
  const resize =
    resizeLengthPpq !== undefined && Math.abs(resizeLengthPpq - clip.lengthPpq) > CLIP_LANE_EPSILON;
  const loopChange =
    options.loop !== undefined &&
    (clip.loopEnabled !== options.loop.enabled ||
      (options.loop.enabled &&
        Math.abs((clip.loopLengthPpq || clip.lengthPpq) - (options.loop.lengthPpq ?? 0)) >
          CLIP_LANE_EPSILON));
  const projectEdits = Number(options.writeNotes) + Number(resize) + Number(loopChange);
  if (projectEdits === 0) return;
  executeAtomic((edit) => {
    if (resize) {
      edit(1, () => project.trimClip(store.clipId, clip.startPpq, resizeLengthPpq as number));
    }
    if (loopChange) {
      edit(1, () => {
        if (options.loop?.enabled) {
          project.setClipLoop(store.clipId, {
            loopMode: 'loop',
            loopLengthPpq: options.loop.lengthPpq,
          });
        } else {
          project.setClipLoop(store.clipId, { loopMode: 'off' });
        }
      });
    }
    if (options.writeNotes) {
      edit(1, () => project.setMidiEvents(store.clipId, notesToProjectEvents(nextNotes)));
    }
    store.refresh(nextNotes);
  });
}

function selectedNotes(): EditorNote[] {
  const store = useProjectStore();
  return store.notes.filter((note) => store.selection.has(note.id));
}

/** Copies the current note selection with its earliest onset rebased to PPQ 0. */
export function copySelectedNotes(): boolean {
  const selected = selectedNotes();
  if (selected.length === 0) return false;
  const originPpq = Math.min(...selected.map((note) => note.startPpq));
  noteClipboard = selected
    .map((note) => ({
      pitch: note.pitch,
      velocity: note.velocity,
      startPpq: note.startPpq - originPpq,
      durationPpq: note.durationPpq,
      channel: note.channel,
      ...(note.offVelocity === undefined ? {} : { offVelocity: note.offVelocity }),
    }))
    .sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch || a.channel - b.channel);
  noteClipboardVersion.value += 1;
  return true;
}

/** Copies the selected notes and removes them only after the copy succeeds. */
export function cutSelectedNotes(): boolean {
  const ids = [...useProjectStore().selection];
  if (!copySelectedNotes()) return false;
  deleteNotes(ids);
  return true;
}

/**
 * Pastes the copied notes with their selection origin aligned to a timeline
 * PPQ position. The active MIDI clip grows to the bar holding the last pasted note.
 *
 * @returns Editor ids assigned to the pasted notes; empty when no MIDI clip or
 * clipboard content is available.
 */
export function pasteNotesAt(positionPpq: number): number[] {
  const store = useProjectStore();
  if (noteClipboard.length === 0 || !Number.isFinite(positionPpq) || positionPpq < 0) return [];
  if (store.clipId < 0) return [];
  const clip = requireEditableClip(store, store.clipId);
  if (clipKind(clip) !== 'midi') return [];
  const sourceStartPpq = Math.max(0, positionPpq - clip.startPpq + clip.sourceOffsetPpq);
  const additions = noteClipboard.map((note) => ({
    ...note,
    startPpq: sourceStartPpq + note.startPpq,
  }));
  const ids = applyNoteEdits({ additions });
  setSelection(ids);
  return ids;
}

/** Builds and validates a detached new-note payload before allocating its editor id. */
function newNoteDraft(input: NewEditorNote): Omit<EditorNote, 'id'> {
  const note: Omit<EditorNote, 'id'> = {
    pitch: input.pitch,
    velocity: input.velocity ?? DEFAULT_VELOCITY,
    startPpq: input.startPpq,
    durationPpq: input.durationPpq,
    channel: input.channel ?? 0,
  };
  if (input.offVelocity !== undefined) note.offVelocity = input.offVelocity;
  validateNote(note);
  return note;
}

/** A mixed update/delete/add plan committed through one Project history entry. */
export interface NoteEditPlan {
  updates?: ReadonlyArray<EditorNoteUpdate>;
  deleteIds?: Iterable<number>;
  additions?: ReadonlyArray<NewEditorNote>;
  /** Optional clip-window mutation committed in the same history entry. */
  clipWindow?: {
    /** New timeline length; omitted to preserve it. */
    lengthPpq?: number;
    /** Loop state after the edit; omitted to preserve it. */
    loopEnabled?: boolean;
    /** Required positive loop length when enabling loop. */
    loopLengthPpq?: number;
  };
}

/**
 * Applies a complete note edit plan as one failure-atomic undo command.
 * Validation and diff construction finish before the Project is touched, so a
 * bad 16th addition cannot leave the first 15 notes or any update/delete live.
 *
 * @returns Editor ids allocated for additions, in input order.
 */
export function applyNoteEdits(plan: NoteEditPlan): number[] {
  const store = useProjectStore();
  if (store.clipId < 0) return addNotesInNewClip(plan.additions ?? []);
  const clip = requireEditableClip(store, store.clipId);
  const lengthPpq = plan.clipWindow?.lengthPpq;
  if (lengthPpq !== undefined && (!Number.isFinite(lengthPpq) || lengthPpq <= 0)) {
    throw new RangeError(`Clip length must be finite and > 0, got ${lengthPpq}`);
  }
  const loopEnabled = plan.clipWindow?.loopEnabled;
  const loopLengthPpq = plan.clipWindow?.loopLengthPpq;
  if (
    loopEnabled === true &&
    (loopLengthPpq === undefined || !Number.isFinite(loopLengthPpq) || loopLengthPpq <= 0)
  ) {
    throw new RangeError(`Loop length must be finite and > 0, got ${loopLengthPpq}`);
  }
  const updates = new Map((plan.updates ?? []).map((update) => [update.id, update]));
  const drop = new Set(plan.deleteIds ?? []);
  const additionDrafts = (plan.additions ?? []).map(newNoteDraft);
  let notesChanged = additionDrafts.length > 0;
  const next = store.notes.flatMap((note): EditorNote[] => {
    if (drop.has(note.id)) {
      notesChanged = true;
      return [];
    }
    const update = updates.get(note.id);
    if (!update) return [{ ...note }];
    notesChanged = true;
    const merged: EditorNote = {
      ...note,
      pitch: update.pitch ?? note.pitch,
      velocity: update.velocity ?? note.velocity,
      startPpq: update.startPpq ?? note.startPpq,
      durationPpq: update.durationPpq ?? note.durationPpq,
      channel: update.channel ?? note.channel,
    };
    if (update.offVelocity !== undefined) merged.offVelocity = update.offVelocity;
    validateNote(merged);
    return [merged];
  });
  const windowChanged =
    (lengthPpq !== undefined && Math.abs(lengthPpq - clip.lengthPpq) > CLIP_LANE_EPSILON) ||
    (loopEnabled !== undefined &&
      (loopEnabled !== clip.loopEnabled ||
        (loopEnabled &&
          Math.abs((clip.loopLengthPpq || clip.lengthPpq) - (loopLengthPpq ?? 0)) >
            CLIP_LANE_EPSILON)));
  if (!notesChanged && !windowChanged) return [];
  const additions = additionDrafts.map((draft) => ({ ...draft, id: allocateNoteId() }));
  commit([...next, ...additions], {
    writeNotes: notesChanged,
    ...(lengthPpq === undefined ? {} : { resizeLengthPpq: lengthPpq }),
    ...(loopEnabled === undefined
      ? {}
      : {
          loop: {
            enabled: loopEnabled,
            ...(loopLengthPpq === undefined ? {} : { lengthPpq: loopLengthPpq }),
          },
        }),
  });
  return additions.map((note) => note.id);
}

/**
 * Writes additions into a new MIDI clip on the active track, which has none.
 * Without an open clip the piano roll's frame is the timeline, so addition
 * positions are timeline PPQ; the clip spans the bars they touch.
 *
 * @param additions Notes positioned in timeline PPQ.
 * @param fromPpq Timeline position the clip should also reach back to, so a
 *   view's visible span becomes the clip; omitted to start at the first note.
 * @returns Editor ids allocated for the additions, in input order.
 */
export function addNotesInNewClip(
  additions: ReadonlyArray<NewEditorNote>,
  fromPpq?: number,
): number[] {
  const store = useProjectStore();
  if (store.activeTrackId < 0) throw new Error('No active clip to edit');
  const track = requireEditableTrack(store, store.activeTrackId);
  if (track.kind !== 'midi') throw new Error('No active clip to edit');
  const drafts = additions.map(newNoteDraft);
  if (drafts.length === 0) return [];
  const firstStart = Math.min(...drafts.map((note) => note.startPpq));
  const lastEnd = Math.max(...drafts.map((note) => note.startPpq + note.durationPpq));
  // The lane may already hold clips on either side: the new clip fills only the gap around the first note.
  const gap = laneGapAround(store.clips, track.id, firstStart);
  if (gap === null) throw new RangeError('Cannot draw a new clip over an existing clip');
  const startPpq = Math.max(
    gap.startPpq,
    measureRangeAt(store.timeSignatures, Math.max(0, Math.min(firstStart, fromPpq ?? firstStart)))
      .startPpq,
  );
  const lastBar = measureRangeAt(store.timeSignatures, Math.max(firstStart, lastEnd - 1e-6));
  const endPpq = Math.min(lastBar.startPpq + lastBar.lengthPpq, gap.endPpq);
  const lengthPpq = endPpq - startPpq;
  if (drafts.some((draft) => draft.startPpq >= endPpq - CLIP_LANE_EPSILON)) {
    throw new RangeError('Cannot draw a new clip across an existing clip');
  }
  const notes = drafts.map((draft) => ({
    ...draft,
    id: allocateNoteId(),
    startPpq: draft.startPpq - startPpq,
    durationPpq: Math.min(draft.durationPpq, endPpq - draft.startPpq),
  }));
  const project = getProject();
  executeAtomic((edit) => {
    const clipId = edit(1, () =>
      project.addClip({ trackId: track.id, isMidi: true, startPpq, lengthPpq }),
    );
    edit(1, () => project.setMidiEvents(clipId, notesToProjectEvents(notes)));
    store.clipId = clipId;
    store.clipSelection = new Set([clipId]);
    store.refresh(notes);
  });
  return notes.map((note) => note.id);
}

/** Adds several notes in one validation/commit/undo transaction. */
export function addNotes(inputs: ReadonlyArray<NewEditorNote>): number[] {
  return applyNoteEdits({ additions: inputs });
}

/**
 * Adds a note to the active clip.
 *
 * @param input Note fields; velocity defaults to 96 and channel to 0.
 * @returns The editor id assigned to the new note.
 */
export function addNote(input: NewEditorNote): number {
  const [id] = addNotes([input]);
  return id;
}

/**
 * Captures a groove from notes, measured against the editor's note-division
 * grid. Bar snapping has no groove meaning, so the numeric division is used
 * even while Bar snap is selected. Steps are counted from each note's bar on
 * the project meter map, so a template captured in one meter still lines up
 * after a meter change.
 *
 * @param notes Reference performance; the selection or a whole clip.
 * @param steps Template period in grid steps.
 * @returns The template, or null when there is nothing to measure.
 */
function captureGroove(notes: readonly EditorNote[], steps: number): GrooveTemplate | null {
  const store = useProjectStore();
  const clip = store.activeClip;
  if (!clip || notes.length === 0) return null;
  const gridPpq = 4 / store.snapDivision;
  if (!(gridPpq > 0) || !Number.isFinite(gridPpq)) return null;
  const positions = notes.map((note) => midiSourcePpqToTimeline(clip, note.startPpq));
  return extractGrooveTemplate(store.timeSignatures, positions, gridPpq, steps);
}

/** Captures a groove template from the selected notes. */
export function captureGrooveFromSelection(steps = DEFAULT_GROOVE_STEPS): GrooveTemplate | null {
  const store = useProjectStore();
  return captureGroove(
    store.notes.filter((note) => store.selection.has(note.id)),
    steps,
  );
}

/** Captures a groove template from every note of the active clip. */
export function captureGrooveFromActiveClip(steps = DEFAULT_GROOVE_STEPS): GrooveTemplate | null {
  const store = useProjectStore();
  return captureGroove(store.notes, steps);
}

/** Moves note starts onto a groove, keeping pitch and duration. */
function applyGroove(notes: readonly EditorNote[], groove: GrooveTemplate, strength: number): void {
  const store = useProjectStore();
  if (notes.length === 0) return;
  const clip = requireEditableClip(store, store.clipId);
  const amount = clamp01(strength);
  const updates: EditorNoteUpdate[] = [];
  for (const note of notes) {
    const timelinePpq = midiSourcePpqToTimeline(clip, note.startPpq);
    const grooved = applyGrooveToPosition(groove, store.timeSignatures, timelinePpq, amount);
    const sourcePpq = Math.max(0, grooved - clip.startPpq + clip.sourceOffsetPpq);
    if (Math.abs(sourcePpq - note.startPpq) < CLIP_LANE_EPSILON) continue;
    updates.push({ id: note.id, startPpq: sourcePpq });
  }
  if (updates.length === 0) return;
  applyNoteEdits({ updates });
}

/** Applies a timing groove to the selected notes as one undoable edit. */
export function applyGrooveToSelection(groove: GrooveTemplate, strength = 1): void {
  const store = useProjectStore();
  applyGroove(
    store.notes.filter((note) => store.selection.has(note.id)),
    groove,
    strength,
  );
}

/** Applies a timing groove to every note of the active clip as one undoable edit. */
export function applyGrooveToActiveClip(groove: GrooveTemplate, strength = 1): void {
  const store = useProjectStore();
  applyGroove(store.notes, groove, strength);
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
  commit(next, { writeNotes: true });
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
  commit(next, { writeNotes: true });
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
  commit([...cloneNotes(store.notes), ...copies], { writeNotes: true });
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
  commit([...cloneNotes(store.notes), ...copies], { writeNotes: true });
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
    if (last && note.startPpq <= last.startPpq + last.durationPpq + CLIP_LANE_EPSILON) {
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
  commit(next, { writeNotes: true });
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
  commit(next, { writeNotes: true });
  setSelection([...store.selection].filter((id) => !drop.has(id)));
}

/**
 * Re-times the selected notes by harmony, meter and phrase as one undoable
 * edit (see {@link tidyNotes}): fragments are joined, ghosts dropped, and
 * melody, bass and inner voices take their own lengths. Pitches never change.
 */
export function tidySelection(): void {
  const store = useProjectStore();
  const selected = selectedNotes();
  if (selected.length === 0) return;
  const clip = requireEditableClip(store, store.clipId);
  const offset = midiSourcePpqToTimeline(clip, 0);
  const tidied = tidyNotes(
    selected.map((note) => ({ ...note, startPpq: note.startPpq + offset })),
    {
      gridPpq: tidyGridPpq(store),
      timeSignatures: store.timeSignatures,
      chords: store.chords,
      endPpq: midiSourcePpqToTimeline(clip, clip.sourceOffsetPpq + clip.lengthPpq),
    },
  );
  const byId = new Map(
    tidied.map((note) => [note.id, { ...note, startPpq: Math.max(0, note.startPpq - offset) }]),
  );
  const next = store.notes.flatMap((note) => {
    if (!store.selection.has(note.id)) return [{ ...note }];
    const kept = byId.get(note.id);
    return kept ? [kept] : [];
  });
  commit(next, { writeNotes: true });
  setSelection(byId.keys());
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
  commit(next, { writeNotes: true });
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
 * Quantizes the start positions of the selected notes to the snap grid as one
 * undoable edit. The grid is locally anchored at every meter segment and can
 * also target complete bars when the editor's Bar snap mode is selected.
 *
 * @param strength 0..1 interpolation toward the grid (default 1 = full snap).
 */
export function quantizeSelection(strength?: number): void {
  const store = useProjectStore();
  if (store.selection.size === 0) return;
  const clip = requireEditableClip(store, store.clipId);
  const gridPpq = store.snapBar ? 'bar' : 4 / store.snapDivision;
  const amount = clamp01(strength ?? store.quantizeStrength);
  let changed = false;
  const next = store.notes.map((note) => {
    if (!store.selection.has(note.id)) return { ...note };
    const timelinePpq = midiSourcePpqToTimeline(clip, note.startPpq);
    const target = snapPpqToSwingMeterGrid(
      store.timeSignatures,
      timelinePpq,
      gridPpq,
      store.quantizeSwing,
    );
    const snapped = timelinePpq + (target - timelinePpq) * amount;
    const sourcePpq = snapped - clip.startPpq + clip.sourceOffsetPpq;
    if (sourcePpq === note.startPpq) return { ...note };
    changed = true;
    return { ...note, startPpq: Math.max(0, sourcePpq) };
  });
  if (changed) commit(next, { writeNotes: true });
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
  commit(next, { writeNotes: true });
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
  if (changed) commit(next, { writeNotes: true });
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
  const clip = requireEditableClip(store, store.clipId);
  let changed = false;
  const next = store.notes.map((note) => {
    if (!store.selection.has(note.id)) return { ...note };
    const target = store.snapBar
      ? Math.max(
          MIN_DURATION_PPQ,
          snapPpqToMeterGrid(
            store.timeSignatures,
            midiSourcePpqToTimeline(clip, note.startPpq + note.durationPpq),
            'bar',
          ) - midiSourcePpqToTimeline(clip, note.startPpq),
        )
      : Math.max(MIN_DURATION_PPQ, Math.round(note.durationPpq / gridPpq) * gridPpq);
    const snapped = note.durationPpq + (target - note.durationPpq) * strength;
    const durationPpq = Math.max(MIN_DURATION_PPQ, snapped);
    if (durationPpq === note.durationPpq) return { ...note };
    changed = true;
    return { ...note, durationPpq };
  });
  if (changed) commit(next, { writeNotes: true });
}

/** Quantizes selected note ends to the snap grid as one undoable edit. */
export function quantizeSelectionEnds(strength = 1): void {
  const store = useProjectStore();
  if (store.selection.size === 0) return;
  const clip = requireEditableClip(store, store.clipId);
  const gridPpq = store.snapBar ? 'bar' : 4 / store.snapDivision;
  const updates: EditorNoteUpdate[] = [];
  for (const note of store.notes) {
    if (!store.selection.has(note.id)) continue;
    const sourceEnd = note.startPpq + note.durationPpq;
    const timelineEnd = midiSourcePpqToTimeline(clip, sourceEnd);
    const target = Math.max(
      midiSourcePpqToTimeline(clip, note.startPpq + MIN_DURATION_PPQ),
      snapPpqToMeterGrid(store.timeSignatures, timelineEnd, gridPpq),
    );
    const nextTimelineEnd = timelineEnd + (target - timelineEnd) * strength;
    const nextSourceEnd = nextTimelineEnd - clip.startPpq + clip.sourceOffsetPpq;
    const durationPpq = Math.max(MIN_DURATION_PPQ, nextSourceEnd - note.startPpq);
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
  if (changed) commit(next, { writeNotes: true });
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
  if (changed) commit(next, { writeNotes: true });
}
