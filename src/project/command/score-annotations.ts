import {
  DISPLAY_TRANSPOSE_MAX,
  DISPLAY_TRANSPOSE_MIN,
  isEmptyScoreAnnotation,
  NOTE_ARTICULATIONS,
  NOTE_DYNAMICS,
  type NoteArticulation,
  type NoteDynamics,
  type ScoreNoteAnnotation,
  scoreAnnotationEquals,
} from '../annotations';
import { useProjectStore } from '../store';
import { execute } from './history';
import { requireClip } from './utils';

/**
 * Partial score-annotation edit for {@link setNoteAnnotation}: a field set to
 * a value replaces it, `null` clears it, `undefined` (omitted) leaves it.
 */
export interface NoteAnnotationUpdate {
  /** Dynamics marking, or null to clear. */
  dynamics?: NoteDynamics | null;
  /** Articulation marking, or null to clear. */
  articulation?: NoteArticulation | null;
  /** Editor note id of the slur target, or null to clear the slur. */
  slurToNoteId?: number | null;
}

/**
 * Sets display-only score annotations on a note as one undoable edit.
 * Annotations are app-level metadata consumed by the engraved score view;
 * the underlying MIDI data is never modified.
 *
 * @param clipId Id of the clip containing the note.
 * @param noteId Editor id of the note to annotate.
 * @param update Field-wise edit; clearing every field removes the entry.
 */
export function setNoteAnnotation(
  clipId: number,
  noteId: number,
  update: NoteAnnotationUpdate,
): void {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  const note = clip.notes.find((n) => n.id === noteId);
  if (!note) throw new RangeError(`Unknown note id: ${noteId}`);
  if (update.dynamics != null && !NOTE_DYNAMICS.includes(update.dynamics)) {
    throw new RangeError(`Unknown dynamics marking: ${update.dynamics}`);
  }
  if (update.articulation != null && !NOTE_ARTICULATIONS.includes(update.articulation)) {
    throw new RangeError(`Unknown articulation marking: ${update.articulation}`);
  }
  if (update.slurToNoteId != null) {
    const target = clip.notes.find((n) => n.id === update.slurToNoteId);
    if (!target) throw new RangeError(`Unknown slur target note id: ${update.slurToNoteId}`);
    if (target.id === noteId || target.startPpq <= note.startPpq) {
      throw new RangeError('Slur target must start after the slurred note');
    }
  }
  const current: ScoreNoteAnnotation = store.scoreAnnotations[clipId]?.[noteId] ?? {};
  const next: ScoreNoteAnnotation = { ...current };
  if (update.dynamics !== undefined) {
    if (update.dynamics === null) delete next.dynamics;
    else next.dynamics = update.dynamics;
  }
  if (update.articulation !== undefined) {
    if (update.articulation === null) delete next.articulation;
    else next.articulation = update.articulation;
  }
  if (update.slurToNoteId !== undefined) {
    if (update.slurToNoteId === null) delete next.slurToNoteId;
    else next.slurToNoteId = update.slurToNoteId;
  }
  if (scoreAnnotationEquals(current, next)) return;
  execute(0, () => {
    const clipAnnotations = { ...(store.scoreAnnotations[clipId] ?? {}) };
    if (isEmptyScoreAnnotation(next)) delete clipAnnotations[noteId];
    else clipAnnotations[noteId] = next;
    const all = { ...store.scoreAnnotations };
    if (Object.keys(clipAnnotations).length === 0) delete all[clipId];
    else all[clipId] = clipAnnotations;
    store.scoreAnnotations = all;
    store.refresh();
  });
}

/**
 * Removes every score annotation of a note as one undoable edit. Works for
 * orphaned entries too (the note may already have been deleted); a missing
 * entry is a no-op.
 *
 * @param clipId Id of the clip the annotation belongs to.
 * @param noteId Editor id the annotation is keyed by.
 */
export function clearNoteAnnotation(clipId: number, noteId: number): void {
  const store = useProjectStore();
  if (store.scoreAnnotations[clipId]?.[noteId] === undefined) return;
  execute(0, () => {
    const clipAnnotations = { ...store.scoreAnnotations[clipId] };
    delete clipAnnotations[noteId];
    const all = { ...store.scoreAnnotations };
    if (Object.keys(clipAnnotations).length === 0) delete all[clipId];
    else all[clipId] = clipAnnotations;
    store.scoreAnnotations = all;
    store.refresh();
  });
}

/**
 * Sets the score display transpose as one undoable edit. The setting shifts
 * engraved pitch spelling only - the MIDI notes are never changed.
 *
 * @param semitones Display transpose in semitones (integer, -12..12).
 */
export function setDisplayTranspose(semitones: number): void {
  const store = useProjectStore();
  if (
    !Number.isInteger(semitones) ||
    semitones < DISPLAY_TRANSPOSE_MIN ||
    semitones > DISPLAY_TRANSPOSE_MAX
  ) {
    throw new RangeError(
      `Display transpose must be an integer in [${DISPLAY_TRANSPOSE_MIN}, ${DISPLAY_TRANSPOSE_MAX}], got ${semitones}`,
    );
  }
  if (store.displayTransposeSemitones === semitones) return;
  execute(0, () => {
    store.displayTransposeSemitones = semitones;
    store.refresh();
  });
}
