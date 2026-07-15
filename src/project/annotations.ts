/**
 * Non-destructive score annotations.
 *
 * Annotations are display-only metadata attached to editor notes for the
 * engraved score view (dynamics, articulations, ornaments, slurs, hairpins,
 * line spans) plus score-wide display settings (display transpose). They are app-level state like
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

/** Ornament or expressive mark attached to a note. */
export type NoteOrnament = 'trill' | 'turn' | 'mordent' | 'fermata';

/** All ornament markings. */
export const NOTE_ORNAMENTS: ReadonlyArray<NoteOrnament> = ['trill', 'turn', 'mordent', 'fermata'];

/** Hairpin/dynamic wedge spanning from one note to a later note. */
export type NoteHairpin = 'crescendo' | 'diminuendo';

/** All hairpin markings. */
export const NOTE_HAIRPINS: ReadonlyArray<NoteHairpin> = ['crescendo', 'diminuendo'];

/** Other note-to-note span markings. */
export type NoteLineSpan =
  | 'ottava-up'
  | 'ottava-down'
  | 'ottava-15-up'
  | 'ottava-15-down'
  | 'pedal'
  | 'glissando';

/** All line span markings. */
export const NOTE_LINE_SPANS: ReadonlyArray<NoteLineSpan> = [
  'ottava-up',
  'ottava-down',
  'ottava-15-up',
  'ottava-15-down',
  'pedal',
  'glissando',
];

/** Pedal MusicXML display style. */
export type PedalLineSpanStyle = 'line' | 'sign';

/** Glissando MusicXML line style. */
export type GlissandoLineType = 'solid' | 'dashed' | 'dotted' | 'wavy';

/** Explicit grand-staff assignment for one engraved note. */
export type NoteStaffOverride = 1 | 2;

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
  /** Ornament or expressive mark on the note. */
  ornament?: NoteOrnament;
  /**
   * Editor note id of a slur target: the slur starts on this note and ends
   * on the target, which must start later. Dangling targets (deleted notes)
   * are ignored at emission time.
   */
  slurToNoteId?: number;
  /** Hairpin type starting on this note. Requires `hairpinToNoteId`. */
  hairpin?: NoteHairpin;
  /** Editor note id where the hairpin stops; must start later than this note. */
  hairpinToNoteId?: number;
  /** Other line/span type starting on this note. Requires `lineSpanToNoteId`. */
  lineSpan?: NoteLineSpan;
  /** Editor note id where the line/span stops; must start later than this note. */
  lineSpanToNoteId?: number;
  /** Pedal display style for the primary line span. */
  pedalStyle?: PedalLineSpanStyle;
  /** Glissando line style for the primary line span. */
  glissandoLineType?: GlissandoLineType;
  /** Optional glissando text for the primary line span. */
  glissandoText?: string;
  /** Additional simultaneous line/spans starting on this note. */
  lineSpans?: ScoreLineSpanAnnotation[];
  /** Explicit grand-staff assignment (1 = upper, 2 = lower). */
  staffOverride?: NoteStaffOverride;
}

/** One simultaneous line/span attached to a note. */
export interface ScoreLineSpanAnnotation {
  /** Line/span type starting on this note. */
  lineSpan: NoteLineSpan;
  /** Editor note id where the line/span stops; must start later than this note. */
  lineSpanToNoteId: number;
  /** Pedal display style. */
  pedalStyle?: PedalLineSpanStyle;
  /** Glissando line style. */
  glissandoLineType?: GlissandoLineType;
  /** Optional glissando text. */
  glissandoText?: string;
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
      clipOut[Number(noteKey)] = {
        ...annotation,
        ...(annotation.lineSpans
          ? { lineSpans: annotation.lineSpans.map((span) => ({ ...span })) }
          : {}),
      };
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
    annotation.ornament === undefined &&
    annotation.slurToNoteId === undefined &&
    annotation.hairpin === undefined &&
    annotation.hairpinToNoteId === undefined &&
    annotation.lineSpan === undefined &&
    annotation.lineSpanToNoteId === undefined &&
    annotation.pedalStyle === undefined &&
    annotation.glissandoLineType === undefined &&
    annotation.glissandoText === undefined &&
    annotation.staffOverride === undefined &&
    (annotation.lineSpans === undefined || annotation.lineSpans.length === 0)
  );
}

function lineSpanArraysEqual(
  a: ReadonlyArray<ScoreLineSpanAnnotation> | undefined,
  b: ReadonlyArray<ScoreLineSpanAnnotation> | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.lineSpan === right[index]?.lineSpan &&
        entry.lineSpanToNoteId === right[index]?.lineSpanToNoteId &&
        entry.pedalStyle === right[index]?.pedalStyle &&
        entry.glissandoLineType === right[index]?.glissandoLineType &&
        entry.glissandoText === right[index]?.glissandoText,
    )
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
    a.ornament === b.ornament &&
    a.slurToNoteId === b.slurToNoteId &&
    a.hairpin === b.hairpin &&
    a.hairpinToNoteId === b.hairpinToNoteId &&
    a.lineSpan === b.lineSpan &&
    a.lineSpanToNoteId === b.lineSpanToNoteId &&
    a.pedalStyle === b.pedalStyle &&
    a.glissandoLineType === b.glissandoLineType &&
    a.glissandoText === b.glissandoText &&
    a.staffOverride === b.staffOverride &&
    lineSpanArraysEqual(a.lineSpans, b.lineSpans)
  );
}

/** Returns legacy and additional line spans without duplicate target/type pairs. */
export function scoreAnnotationLineSpans(
  annotation: Readonly<ScoreNoteAnnotation>,
): ScoreLineSpanAnnotation[] {
  const out: ScoreLineSpanAnnotation[] = [];
  const push = (entry: ScoreLineSpanAnnotation): void => {
    if (
      !out.some(
        (existing) =>
          existing.lineSpan === entry.lineSpan &&
          existing.lineSpanToNoteId === entry.lineSpanToNoteId,
      )
    ) {
      out.push({ ...entry });
    }
  };
  if (annotation.lineSpan !== undefined && annotation.lineSpanToNoteId !== undefined) {
    push({
      lineSpan: annotation.lineSpan,
      lineSpanToNoteId: annotation.lineSpanToNoteId,
      ...(annotation.pedalStyle !== undefined ? { pedalStyle: annotation.pedalStyle } : {}),
      ...(annotation.glissandoLineType !== undefined
        ? { glissandoLineType: annotation.glissandoLineType }
        : {}),
      ...(annotation.glissandoText !== undefined
        ? { glissandoText: annotation.glissandoText }
        : {}),
    });
  }
  for (const entry of annotation.lineSpans ?? []) push(entry);
  return out;
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
  /** Zero-based ordinal among otherwise identical pitch/start/channel notes. */
  ordinal?: number;
}

/** One persisted note annotation inside a document clip. */
export interface DocumentNoteAnnotation extends DocumentNoteRef {
  /** Dynamics marking, when set. */
  dynamics?: NoteDynamics;
  /** Articulation marking, when set. */
  articulation?: NoteArticulation;
  /** Ornament or expressive mark, when set. */
  ornament?: NoteOrnament;
  /** Slur target note (content-addressed), when a slur starts here. */
  slurTo?: DocumentNoteRef;
  /** Hairpin type, when a dynamic wedge starts here. */
  hairpin?: NoteHairpin;
  /** Hairpin target note (content-addressed), when a hairpin starts here. */
  hairpinTo?: DocumentNoteRef;
  /** Other line/span type, when a span starts here. */
  lineSpan?: NoteLineSpan;
  /** Other line/span target note (content-addressed), when a span starts here. */
  lineSpanTo?: DocumentNoteRef;
  /** Pedal display style for the primary line span. */
  pedalStyle?: PedalLineSpanStyle;
  /** Glissando line style for the primary line span. */
  glissandoLineType?: GlissandoLineType;
  /** Optional glissando text for the primary line span. */
  glissandoText?: string;
  /** Additional simultaneous line/spans starting here. */
  lineSpans?: DocumentLineSpanAnnotation[];
  /** Explicit grand-staff assignment (1 = upper, 2 = lower). */
  staffOverride?: NoteStaffOverride;
}

/** Persisted form of one additional simultaneous line/span. */
export interface DocumentLineSpanAnnotation {
  /** Other line/span type, when a span starts here. */
  lineSpan: NoteLineSpan;
  /** Other line/span target note (content-addressed). */
  lineSpanTo: DocumentNoteRef;
  /** Pedal display style. */
  pedalStyle?: PedalLineSpanStyle;
  /** Glissando line style. */
  glissandoLineType?: GlissandoLineType;
  /** Optional glissando text. */
  glissandoText?: string;
}

/** Display-quantize choices supported by the score toolbar. */
export type ScoreDisplayQuantizeKey = '4' | '8' | '16' | '32' | '8t' | '16t';

/** Project-owned score display/layout settings. */
export interface ScoreDisplaySettings {
  displayQuantizeKey: ScoreDisplayQuantizeKey;
  chordsEnabled: boolean;
  fullScoreEnabled: boolean;
  estimateFingering: boolean;
  pageFormat: 'a4' | 'letter';
  landscape: boolean;
  pageMarginMm: number;
  scalePercent: number;
  spacingStaff: number;
  barsPerSystem: number;
  barsPerPage: number;
  grandStaffSplitPitch: number;
  viewZoom: number;
}

/** Builds a fresh default score-settings object for a project lifecycle. */
export function createDefaultScoreDisplaySettings(): ScoreDisplaySettings {
  return {
    displayQuantizeKey: '16',
    chordsEnabled: false,
    fullScoreEnabled: false,
    estimateFingering: false,
    pageFormat: 'a4',
    landscape: false,
    pageMarginMm: 10,
    scalePercent: 50,
    spacingStaff: 12,
    barsPerSystem: 4,
    barsPerPage: 16,
    grandStaffSplitPitch: 60,
    viewZoom: 1,
  };
}

/** Persisted score display settings (individual default fields are omitted). */
export interface DocumentScoreSettings {
  /** Display transpose in semitones (engraving only, never applied to MIDI). */
  displayTransposeSemitones?: number;
  displayQuantizeKey?: ScoreDisplayQuantizeKey;
  chordsEnabled?: boolean;
  fullScoreEnabled?: boolean;
  estimateFingering?: boolean;
  pageFormat?: 'a4' | 'letter';
  landscape?: boolean;
  pageMarginMm?: number;
  scalePercent?: number;
  spacingStaff?: number;
  barsPerSystem?: number;
  barsPerPage?: number;
  grandStaffSplitPitch?: number;
  viewZoom?: number;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const bounded = Math.min(max, Math.max(min, value));
  return integer ? Math.round(bounded) : bounded;
}

/** Validates a loaded document's optional score settings and supplies defaults. */
export function scoreDisplaySettingsFromDocument(
  source: Readonly<DocumentScoreSettings> | undefined,
): ScoreDisplaySettings {
  const defaults = createDefaultScoreDisplaySettings();
  const quantize = source?.displayQuantizeKey;
  return {
    displayQuantizeKey:
      quantize === '4' ||
      quantize === '8' ||
      quantize === '16' ||
      quantize === '32' ||
      quantize === '8t' ||
      quantize === '16t'
        ? quantize
        : defaults.displayQuantizeKey,
    chordsEnabled:
      typeof source?.chordsEnabled === 'boolean' ? source.chordsEnabled : defaults.chordsEnabled,
    fullScoreEnabled:
      typeof source?.fullScoreEnabled === 'boolean'
        ? source.fullScoreEnabled
        : defaults.fullScoreEnabled,
    estimateFingering:
      typeof source?.estimateFingering === 'boolean'
        ? source.estimateFingering
        : defaults.estimateFingering,
    pageFormat:
      source?.pageFormat === 'a4' || source?.pageFormat === 'letter'
        ? source.pageFormat
        : defaults.pageFormat,
    landscape: typeof source?.landscape === 'boolean' ? source.landscape : defaults.landscape,
    pageMarginMm: boundedNumber(source?.pageMarginMm, defaults.pageMarginMm, 0, 40),
    scalePercent: boundedNumber(source?.scalePercent, defaults.scalePercent, 20, 100, true),
    spacingStaff: boundedNumber(source?.spacingStaff, defaults.spacingStaff, 0, 48, true),
    barsPerSystem: boundedNumber(source?.barsPerSystem, defaults.barsPerSystem, 0, 12, true),
    barsPerPage: boundedNumber(source?.barsPerPage, defaults.barsPerPage, 0, 48, true),
    grandStaffSplitPitch: boundedNumber(
      source?.grandStaffSplitPitch,
      defaults.grandStaffSplitPitch,
      0,
      127,
      true,
    ),
    viewZoom: boundedNumber(source?.viewZoom, defaults.viewZoom, 0.25, 4),
  };
}

/** PPQ values are keyed at micro-PPQ resolution to absorb float round-trip noise. */
const KEY_PPQ_SCALE = 1e6;

/** Content key shared by document refs and editor notes. */
function refKey(ref: Readonly<DocumentNoteRef>): string {
  return `${ref.pitch}|${Math.round(ref.startPpq * KEY_PPQ_SCALE)}|${ref.channel}|${ref.ordinal ?? 0}`;
}

/** Copies the content-reference fields of a note. */
function toNoteRef(note: Readonly<EditorNote>, ordinal = 0): DocumentNoteRef {
  return {
    pitch: note.pitch,
    startPpq: note.startPpq,
    channel: note.channel,
    ...(ordinal > 0 ? { ordinal } : {}),
  };
}

/** Assigns deterministic ordinals to content-identical notes in mirror order. */
function noteRefsById(notes: ReadonlyArray<EditorNote>): Map<number, DocumentNoteRef> {
  const counts = new Map<string, number>();
  const refs = new Map<number, DocumentNoteRef>();
  for (const note of notes) {
    const base = refKey(toNoteRef(note));
    const ordinal = counts.get(base) ?? 0;
    counts.set(base, ordinal + 1);
    refs.set(note.id, toNoteRef(note, ordinal));
  }
  return refs;
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
  const refs = noteRefsById(notes);
  const out: DocumentNoteAnnotation[] = [];
  for (const [noteKey, annotation] of Object.entries(annotations)) {
    const note = byId.get(Number(noteKey));
    if (!note) continue; // Orphaned annotation: the note was deleted.
    const entry: DocumentNoteAnnotation = { ...(refs.get(note.id) ?? toNoteRef(note)) };
    if (annotation.dynamics !== undefined) entry.dynamics = annotation.dynamics;
    if (annotation.articulation !== undefined) entry.articulation = annotation.articulation;
    if (annotation.ornament !== undefined) entry.ornament = annotation.ornament;
    if (annotation.staffOverride !== undefined) entry.staffOverride = annotation.staffOverride;
    if (annotation.slurToNoteId !== undefined) {
      const target = byId.get(annotation.slurToNoteId);
      if (target) entry.slurTo = refs.get(target.id) ?? toNoteRef(target);
    }
    if (annotation.hairpin !== undefined && annotation.hairpinToNoteId !== undefined) {
      const target = byId.get(annotation.hairpinToNoteId);
      if (target) {
        entry.hairpin = annotation.hairpin;
        entry.hairpinTo = refs.get(target.id) ?? toNoteRef(target);
      }
    }
    if (annotation.lineSpan !== undefined && annotation.lineSpanToNoteId !== undefined) {
      const target = byId.get(annotation.lineSpanToNoteId);
      if (target) {
        entry.lineSpan = annotation.lineSpan;
        entry.lineSpanTo = refs.get(target.id) ?? toNoteRef(target);
        if (annotation.pedalStyle !== undefined) entry.pedalStyle = annotation.pedalStyle;
        if (annotation.glissandoLineType !== undefined) {
          entry.glissandoLineType = annotation.glissandoLineType;
        }
        if (annotation.glissandoText !== undefined) entry.glissandoText = annotation.glissandoText;
      }
    }
    const additionalLineSpans: DocumentLineSpanAnnotation[] = [];
    for (const span of annotation.lineSpans ?? []) {
      const target = byId.get(span.lineSpanToNoteId);
      if (!target) continue;
      if (
        annotation.lineSpan === span.lineSpan &&
        annotation.lineSpanToNoteId === span.lineSpanToNoteId
      ) {
        continue;
      }
      additionalLineSpans.push({
        lineSpan: span.lineSpan,
        lineSpanTo: refs.get(target.id) ?? toNoteRef(target),
        ...(span.pedalStyle !== undefined ? { pedalStyle: span.pedalStyle } : {}),
        ...(span.glissandoLineType !== undefined
          ? { glissandoLineType: span.glissandoLineType }
          : {}),
        ...(span.glissandoText !== undefined ? { glissandoText: span.glissandoText } : {}),
      });
    }
    if (additionalLineSpans.length > 0) entry.lineSpans = additionalLineSpans;
    if (
      entry.dynamics === undefined &&
      entry.articulation === undefined &&
      entry.ornament === undefined &&
      entry.staffOverride === undefined &&
      !entry.slurTo &&
      !entry.hairpinTo &&
      !entry.lineSpanTo &&
      (entry.lineSpans === undefined || entry.lineSpans.length === 0)
    ) {
      continue; // Nothing survived (e.g. a slur whose target was deleted).
    }
    out.push(entry);
  }
  out.sort(
    (a, b) =>
      a.startPpq - b.startPpq ||
      a.pitch - b.pitch ||
      a.channel - b.channel ||
      (a.ordinal ?? 0) - (b.ordinal ?? 0),
  );
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
  for (const [id, ref] of noteRefsById(notes)) {
    idByKey.set(refKey(ref), id);
  }
  const out: ClipScoreAnnotations = {};
  for (const entry of entries) {
    const id = idByKey.get(refKey(entry));
    if (id === undefined) continue;
    const annotation: ScoreNoteAnnotation = {};
    if (entry.dynamics !== undefined) annotation.dynamics = entry.dynamics;
    if (entry.articulation !== undefined) annotation.articulation = entry.articulation;
    if (entry.ornament !== undefined) annotation.ornament = entry.ornament;
    if (entry.staffOverride === 1 || entry.staffOverride === 2) {
      annotation.staffOverride = entry.staffOverride;
    }
    if (entry.slurTo !== undefined) {
      const targetId = idByKey.get(refKey(entry.slurTo));
      if (targetId !== undefined && targetId !== id) annotation.slurToNoteId = targetId;
    }
    if (entry.hairpin !== undefined && entry.hairpinTo !== undefined) {
      const targetId = idByKey.get(refKey(entry.hairpinTo));
      if (targetId !== undefined && targetId !== id) {
        annotation.hairpin = entry.hairpin;
        annotation.hairpinToNoteId = targetId;
      }
    }
    if (entry.lineSpan !== undefined && entry.lineSpanTo !== undefined) {
      const targetId = idByKey.get(refKey(entry.lineSpanTo));
      if (targetId !== undefined && targetId !== id) {
        annotation.lineSpan = entry.lineSpan;
        annotation.lineSpanToNoteId = targetId;
        if (entry.pedalStyle !== undefined) annotation.pedalStyle = entry.pedalStyle;
        if (entry.glissandoLineType !== undefined) {
          annotation.glissandoLineType = entry.glissandoLineType;
        }
        if (entry.glissandoText !== undefined) annotation.glissandoText = entry.glissandoText;
      }
    }
    const lineSpans: ScoreLineSpanAnnotation[] = [];
    for (const span of entry.lineSpans ?? []) {
      const targetId = idByKey.get(refKey(span.lineSpanTo));
      if (targetId !== undefined && targetId !== id) {
        lineSpans.push({
          lineSpan: span.lineSpan,
          lineSpanToNoteId: targetId,
          ...(span.pedalStyle !== undefined ? { pedalStyle: span.pedalStyle } : {}),
          ...(span.glissandoLineType !== undefined
            ? { glissandoLineType: span.glissandoLineType }
            : {}),
          ...(span.glissandoText !== undefined ? { glissandoText: span.glissandoText } : {}),
        });
      }
    }
    if (lineSpans.length > 0) annotation.lineSpans = lineSpans;
    if (!isEmptyScoreAnnotation(annotation)) out[id] = annotation;
  }
  return out;
}
