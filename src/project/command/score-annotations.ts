import { timeSignatureAtPpq } from '@/compose/meter';
import { type OrnamentMark, planOrnaments } from '@/compose/ornaments';
import {
  DISPLAY_TRANSPOSE_MAX,
  DISPLAY_TRANSPOSE_MIN,
  type GlissandoLineType,
  isEmptyScoreAnnotation,
  NOTE_ARTICULATIONS,
  NOTE_DYNAMICS,
  NOTE_HAIRPINS,
  NOTE_LINE_SPANS,
  NOTE_ORNAMENTS,
  type NoteArticulation,
  type NoteDynamics,
  type NoteHairpin,
  type NoteLineSpan,
  type NoteOrnament,
  type NoteStaffOverride,
  type PedalLineSpanStyle,
  type ScoreNoteAnnotation,
  scoreAnnotationEquals,
  scoreAnnotationLineSpans,
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
  /** Ornament or expressive mark, or null to clear. */
  ornament?: NoteOrnament | null;
  /** Editor note id of the slur target, or null to clear the slur. */
  slurToNoteId?: number | null;
  /** Hairpin type, or null to clear both hairpin fields. */
  hairpin?: NoteHairpin | null;
  /** Editor note id of the hairpin target, or null to clear both hairpin fields. */
  hairpinToNoteId?: number | null;
  /** Line/span type, or null to clear both line span fields. */
  lineSpan?: NoteLineSpan | null;
  /** Editor note id of the line/span target, or null to clear both line span fields. */
  lineSpanToNoteId?: number | null;
  /** Pedal style for the primary line span, or null to clear. */
  pedalStyle?: PedalLineSpanStyle | null;
  /** Glissando line style for the primary line span, or null to clear. */
  glissandoLineType?: GlissandoLineType | null;
  /** Glissando text for the primary line span, or null to clear. */
  glissandoText?: string | null;
  /** Explicit grand-staff assignment, or null to return to automatic staff selection. */
  staffOverride?: NoteStaffOverride | null;
  /** Adds one simultaneous line/span without replacing existing spans. */
  addLineSpan?: {
    lineSpan: NoteLineSpan;
    lineSpanToNoteId: number;
    pedalStyle?: PedalLineSpanStyle;
    glissandoLineType?: GlissandoLineType;
    glissandoText?: string;
  } | null;
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
  if (update.ornament != null && !NOTE_ORNAMENTS.includes(update.ornament)) {
    throw new RangeError(`Unknown ornament marking: ${update.ornament}`);
  }
  if (update.hairpin != null && !NOTE_HAIRPINS.includes(update.hairpin)) {
    throw new RangeError(`Unknown hairpin marking: ${update.hairpin}`);
  }
  if (update.lineSpan != null && !NOTE_LINE_SPANS.includes(update.lineSpan)) {
    throw new RangeError(`Unknown line span marking: ${update.lineSpan}`);
  }
  if (update.addLineSpan != null && !NOTE_LINE_SPANS.includes(update.addLineSpan.lineSpan)) {
    throw new RangeError(`Unknown line span marking: ${update.addLineSpan.lineSpan}`);
  }
  if (update.pedalStyle != null && update.pedalStyle !== 'line' && update.pedalStyle !== 'sign') {
    throw new RangeError(`Unknown pedal style: ${update.pedalStyle}`);
  }
  if (
    update.glissandoLineType != null &&
    !['solid', 'dashed', 'dotted', 'wavy'].includes(update.glissandoLineType)
  ) {
    throw new RangeError(`Unknown glissando line type: ${update.glissandoLineType}`);
  }
  if (update.staffOverride != null && update.staffOverride !== 1 && update.staffOverride !== 2) {
    throw new RangeError(`Unknown staff override: ${update.staffOverride}`);
  }
  if (update.slurToNoteId != null) {
    const target = clip.notes.find((n) => n.id === update.slurToNoteId);
    if (!target) throw new RangeError(`Unknown slur target note id: ${update.slurToNoteId}`);
    if (target.id === noteId || target.startPpq <= note.startPpq) {
      throw new RangeError('Slur target must start after the slurred note');
    }
  }
  if (update.hairpinToNoteId != null) {
    const target = clip.notes.find((n) => n.id === update.hairpinToNoteId);
    if (!target) throw new RangeError(`Unknown hairpin target note id: ${update.hairpinToNoteId}`);
    if (target.id === noteId || target.startPpq <= note.startPpq) {
      throw new RangeError('Hairpin target must start after the source note');
    }
  }
  if (update.lineSpanToNoteId != null) {
    const target = clip.notes.find((n) => n.id === update.lineSpanToNoteId);
    if (!target)
      throw new RangeError(`Unknown line span target note id: ${update.lineSpanToNoteId}`);
    if (target.id === noteId || target.startPpq <= note.startPpq) {
      throw new RangeError('Line span target must start after the source note');
    }
  }
  if (update.addLineSpan != null) {
    const target = clip.notes.find((n) => n.id === update.addLineSpan?.lineSpanToNoteId);
    if (!target)
      throw new RangeError(
        `Unknown line span target note id: ${update.addLineSpan.lineSpanToNoteId}`,
      );
    if (target.id === noteId || target.startPpq <= note.startPpq) {
      throw new RangeError('Line span target must start after the source note');
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
  if (update.ornament !== undefined) {
    if (update.ornament === null) delete next.ornament;
    else next.ornament = update.ornament;
  }
  if (update.slurToNoteId !== undefined) {
    if (update.slurToNoteId === null) delete next.slurToNoteId;
    else next.slurToNoteId = update.slurToNoteId;
  }
  if (update.hairpin !== undefined) {
    if (update.hairpin === null) {
      delete next.hairpin;
      delete next.hairpinToNoteId;
    } else next.hairpin = update.hairpin;
  }
  if (update.hairpinToNoteId !== undefined) {
    if (update.hairpinToNoteId === null) {
      delete next.hairpin;
      delete next.hairpinToNoteId;
    } else next.hairpinToNoteId = update.hairpinToNoteId;
  }
  if (next.hairpin !== undefined && next.hairpinToNoteId === undefined) {
    delete next.hairpin;
  }
  if (update.lineSpan !== undefined) {
    if (update.lineSpan === null) {
      delete next.lineSpan;
      delete next.lineSpanToNoteId;
      delete next.pedalStyle;
      delete next.glissandoLineType;
      delete next.glissandoText;
      delete next.lineSpans;
    } else next.lineSpan = update.lineSpan;
  }
  if (update.lineSpanToNoteId !== undefined) {
    if (update.lineSpanToNoteId === null) {
      delete next.lineSpan;
      delete next.lineSpanToNoteId;
    } else next.lineSpanToNoteId = update.lineSpanToNoteId;
  }
  if (next.lineSpan !== undefined && next.lineSpanToNoteId === undefined) {
    delete next.lineSpan;
  }
  if (update.pedalStyle !== undefined) {
    if (update.pedalStyle === null) delete next.pedalStyle;
    else next.pedalStyle = update.pedalStyle;
  }
  if (update.glissandoLineType !== undefined) {
    if (update.glissandoLineType === null) delete next.glissandoLineType;
    else next.glissandoLineType = update.glissandoLineType;
  }
  if (update.glissandoText !== undefined) {
    const text = update.glissandoText?.trim() ?? '';
    if (text.length === 0) delete next.glissandoText;
    else next.glissandoText = text;
  }
  if (update.staffOverride !== undefined) {
    if (update.staffOverride === null) delete next.staffOverride;
    else next.staffOverride = update.staffOverride;
  }
  if (update.addLineSpan !== undefined && update.addLineSpan !== null) {
    const spans = scoreAnnotationLineSpans(next);
    const exists = spans.some(
      (span) =>
        span.lineSpan === update.addLineSpan?.lineSpan &&
        span.lineSpanToNoteId === update.addLineSpan.lineSpanToNoteId,
    );
    if (!exists) {
      spans.push({
        ...update.addLineSpan,
        ...(update.addLineSpan.glissandoText !== undefined
          ? { glissandoText: update.addLineSpan.glissandoText.trim() }
          : {}),
      });
      const [primary, ...additional] = spans;
      next.lineSpan = primary.lineSpan;
      next.lineSpanToNoteId = primary.lineSpanToNoteId;
      if (additional.length > 0) next.lineSpans = additional;
      else delete next.lineSpans;
    }
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

/** Options for {@link ornamentClipNotes}. */
export interface OrnamentClipOptions {
  /** Which decoration to write. */
  mark: OrnamentMark;
  /** How much of the eligible material is decorated, in [0, 1]. */
  amount: number;
  /** Tempo, which the difficulty ceiling needs to reject what is too fast. */
  bpm?: number;
  /** Hardest the result may be to play, 1..5; omitted means no ceiling. */
  difficulty?: number;
  /** Fixes which notes are decorated; the same seed writes the same marks. */
  seed?: number;
}

/**
 * Marks a clip's notes with an articulation as one undoable edit.
 *
 * Which notes are eligible follows from the mark and the meter, so this writes
 * a reading of the passage rather than a blanket setting. Notes already marked
 * by hand keep the mark they have, and no note, onset or duration is changed:
 * the pass only annotates. Use {@link planOrnaments} to show what it would do
 * before calling this.
 *
 * @param clipId Id of the clip to decorate.
 * @param options The decoration, its amount, and the context that limits it.
 * @returns How many notes were marked (0 when the pass found nothing eligible).
 * @throws RangeError when the clip is unknown.
 */
export function ornamentClipNotes(clipId: number, options: OrnamentClipOptions): number {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  const existing = store.scoreAnnotations[clipId] ?? {};
  const keep = new Set(
    Object.entries(existing)
      .filter(([, annotation]) => annotation.articulation !== undefined)
      .map(([noteId]) => Number(noteId)),
  );
  const { marks } = planOrnaments(clip.notes, {
    mark: options.mark,
    amount: options.amount,
    ts: timeSignatureAtPpq(store.timeSignatures, clip.startPpq),
    ...(options.bpm !== undefined ? { bpm: options.bpm } : {}),
    ...(options.difficulty !== undefined ? { difficulty: options.difficulty } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    keep,
  });
  if (marks.length === 0) return 0;
  execute(0, () => {
    const clipAnnotations = { ...existing };
    for (const mark of marks) {
      clipAnnotations[mark.noteId] = {
        ...(clipAnnotations[mark.noteId] ?? {}),
        articulation: mark.articulation,
      };
    }
    store.scoreAnnotations = { ...store.scoreAnnotations, [clipId]: clipAnnotations };
    store.refresh();
  });
  return marks.length;
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
