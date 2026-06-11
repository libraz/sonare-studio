/**
 * Non-destructive score annotations.
 *
 * Annotations are display-only metadata attached to editor notes for the
 * engraved score view (dynamics, articulations, slurs) plus score-wide
 * display settings (display transpose). They are app-level state like
 * markers/sections: the wasm Project never sees them and they are never
 * written back to MIDI data.
 *
 * Runtime state is keyed by session-scoped ids (clip id, then editor note
 * id). Because neither id survives serialization, the document form is
 * content-addressed (pitch + startPpq + channel) and re-associated onto
 * fresh ids when a document loads.
 */

import type { EditorNote } from './types';

/** Dynamics marking attached to a note (MusicXML dynamics element names). */
export type NoteDynamics = 'pp' | 'p' | 'mp' | 'mf' | 'f' | 'ff';

/** All dynamics markings, softest first. */
export const NOTE_DYNAMICS: ReadonlyArray<NoteDynamics> = ['pp', 'p', 'mp', 'mf', 'f', 'ff'];

/** Articulation marking attached to a note. */
export type NoteArticulation = 'staccato' | 'accent' | 'tenuto' | 'marcato';

/** All articulation markings. */
export const NOTE_ARTICULATIONS: ReadonlyArray<NoteArticulation> = [
  'staccato',
  'accent',
  'tenuto',
  'marcato',
];

/** Inclusive bounds for the display transpose setting, in semitones. */
export const DISPLAY_TRANSPOSE_MIN = -12;
export const DISPLAY_TRANSPOSE_MAX = 12;

/**
 * Display annotations of one editor note. All fields are optional; an
 * annotation with no fields set is dropped from the store entirely.
 */
export interface ScoreNoteAnnotation {
  /** Dynamics marking placed at the note's onset. */
  dynamics?: NoteDynamics;
  /** Articulation marking on the note head. */
  articulation?: NoteArticulation;
  /**
   * Editor note id of a slur target: the slur starts on this note and ends
   * on the target, which must start later. Dangling targets (deleted notes)
   * are ignored at emission time.
   */
  slurToNoteId?: number;
}

/** Per-note annotations of one clip, keyed by editor note id. */
export type ClipScoreAnnotations = Record<number, ScoreNoteAnnotation>;

/** All score annotations of a project, keyed by clip id then note id. */
export type ScoreAnnotations = Record<number, ClipScoreAnnotations>;

/** Deep-copies a score-annotation state (plain records all the way down). */
export function cloneScoreAnnotations(source: Readonly<ScoreAnnotations>): ScoreAnnotations {
  const out: ScoreAnnotations = {};
  for (const [clipKey, byNote] of Object.entries(source)) {
    const clipOut: ClipScoreAnnotations = {};
    for (const [noteKey, annotation] of Object.entries(byNote)) {
      clipOut[Number(noteKey)] = { ...annotation };
    }
    out[Number(clipKey)] = clipOut;
  }
  return out;
}

/** True when an annotation carries no fields (and should be dropped). */
export function isEmptyScoreAnnotation(annotation: Readonly<ScoreNoteAnnotation>): boolean {
  return (
    annotation.dynamics === undefined &&
    annotation.articulation === undefined &&
    annotation.slurToNoteId === undefined
  );
}

/** Field-wise equality of two note annotations. */
export function scoreAnnotationEquals(
  a: Readonly<ScoreNoteAnnotation>,
  b: Readonly<ScoreNoteAnnotation>,
): boolean {
  return (
    a.dynamics === b.dynamics &&
    a.articulation === b.articulation &&
    a.slurToNoteId === b.slurToNoteId
  );
}

// ---------------------------------------------------------------------------
// Document (persisted) form
// ---------------------------------------------------------------------------

/**
 * Content-addressed reference to one note of a document clip. Editor note
 * ids are session-scoped and never persisted, so document annotations
 * address notes by their identifying content instead.
 */
export interface DocumentNoteRef {
  /** MIDI note number (integer, 0-127). */
  pitch: number;
  /** Note start within the clip, in PPQ. */
  startPpq: number;
  /** MIDI channel (integer, 0-15). */
  channel: number;
}

/** One persisted note annotation inside a document clip. */
export interface DocumentNoteAnnotation extends DocumentNoteRef {
  /** Dynamics marking, when set. */
  dynamics?: NoteDynamics;
  /** Articulation marking, when set. */
  articulation?: NoteArticulation;
  /** Slur target note (content-addressed), when a slur starts here. */
  slurTo?: DocumentNoteRef;
}

/** Persisted score display settings (omitted from documents when default). */
export interface DocumentScoreSettings {
  /** Display transpose in semitones (engraving only, never applied to MIDI). */
  displayTransposeSemitones: number;
}

/** PPQ values are keyed at micro-PPQ resolution to absorb float round-trip noise. */
const KEY_PPQ_SCALE = 1e6;

/** Content key shared by document refs and editor notes. */
function refKey(ref: Readonly<DocumentNoteRef>): string {
  return `${ref.pitch}|${Math.round(ref.startPpq * KEY_PPQ_SCALE)}|${ref.channel}`;
}

/** Copies the content-reference fields of a note. */
function toNoteRef(note: Readonly<EditorNote>): DocumentNoteRef {
  return { pitch: note.pitch, startPpq: note.startPpq, channel: note.channel };
}

/**
 * Converts one clip's annotations to the persisted, content-addressed form.
 *
 * Orphaned entries (the annotated note no longer exists in the clip) are
 * dropped; slur targets that no longer exist drop only the slur. Output
 * order is deterministic (by start position, then pitch, then channel).
 *
 * @param annotations Per-note annotations keyed by editor note id.
 * @param notes The clip's current notes (id association source).
 * @returns Document entries; empty when nothing survives.
 */
export function annotationsToDocument(
  annotations: Readonly<ClipScoreAnnotations>,
  notes: ReadonlyArray<EditorNote>,
): DocumentNoteAnnotation[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const out: DocumentNoteAnnotation[] = [];
  for (const [noteKey, annotation] of Object.entries(annotations)) {
    const note = byId.get(Number(noteKey));
    if (!note) continue; // Orphaned annotation: the note was deleted.
    const entry: DocumentNoteAnnotation = toNoteRef(note);
    if (annotation.dynamics !== undefined) entry.dynamics = annotation.dynamics;
    if (annotation.articulation !== undefined) entry.articulation = annotation.articulation;
    if (annotation.slurToNoteId !== undefined) {
      const target = byId.get(annotation.slurToNoteId);
      if (target) entry.slurTo = toNoteRef(target);
    }
    if (entry.dynamics === undefined && entry.articulation === undefined && !entry.slurTo) {
      continue; // Nothing survived (e.g. a slur whose target was deleted).
    }
    out.push(entry);
  }
  out.sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch || a.channel - b.channel);
  return out;
}

/**
 * Re-associates persisted annotations onto freshly loaded editor notes by
 * content key. Entries (or slur targets) matching no note are dropped; when
 * several notes share a content key the first one wins.
 *
 * @param entries Document annotations of one clip.
 * @param notes The clip's loaded notes with their new editor ids.
 * @returns Per-note annotations keyed by editor note id.
 */
export function annotationsFromDocument(
  entries: ReadonlyArray<DocumentNoteAnnotation>,
  notes: ReadonlyArray<EditorNote>,
): ClipScoreAnnotations {
  const idByKey = new Map<string, number>();
  for (const note of notes) {
    const key = refKey(note);
    if (!idByKey.has(key)) idByKey.set(key, note.id);
  }
  const out: ClipScoreAnnotations = {};
  for (const entry of entries) {
    const id = idByKey.get(refKey(entry));
    if (id === undefined) continue;
    const annotation: ScoreNoteAnnotation = {};
    if (entry.dynamics !== undefined) annotation.dynamics = entry.dynamics;
    if (entry.articulation !== undefined) annotation.articulation = entry.articulation;
    if (entry.slurTo !== undefined) {
      const targetId = idByKey.get(refKey(entry.slurTo));
      if (targetId !== undefined && targetId !== id) annotation.slurToNoteId = targetId;
    }
    if (!isEmptyScoreAnnotation(annotation)) out[id] = annotation;
  }
  return out;
}
