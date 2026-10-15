/**
 * Shared notation data model.
 *
 * This module is the contract between the display quantizer (producer) and
 * the MusicXML serializer (consumer). It describes a non-destructive,
 * display-only "prettified" view computed from editor notes; nothing in this
 * model is ever written back to the underlying MIDI data.
 *
 * PPQ convention: all `*Ppq` fields use the same unit as `EditorNote`
 * (1.0 = one quarter note, fractional values allowed). `startPpq` values are
 * absolute (measured from the score origin), not measure-relative.
 */

import type { ScoreNoteAnnotation } from '@/project/annotations';
import type { MidiSourceIdentity } from '@/project/midi-projection';
import { PPQ_EPSILON } from './musicxml-shared';

/** Base (undotted) note duration, from whole note down to 64th note. */
export type NoteValueBase = 'whole' | 'half' | 'quarter' | 'eighth' | '16th' | '32nd' | '64th';

/** Number of augmentation dots on a note value. */
export type NoteValueDots = 0 | 1 | 2;

/** Tuplet timing ratio for a notated value. */
export interface NoteTuplet {
  /** Number of written notes in the tuplet group, e.g. 3 for triplets. */
  actual: number;
  /** Number of normal notes they occupy, e.g. 2 for triplets. */
  normal: number;
}

/** A notatable duration: a base note value plus augmentation dots. */
export interface NoteValue {
  /** Undotted base duration. */
  base: NoteValueBase;
  /** Augmentation dots (0 = plain, 1 = dotted, 2 = double-dotted). */
  dots: NoteValueDots;
  /** Optional tuplet ratio. Currently produced for triplets (3 in the time of 2). */
  tuplet?: NoteTuplet;
}

/** Duration of each undotted base value in PPQ (quarter note = 1.0). */
export const NOTE_VALUE_BASE_PPQ: Readonly<Record<NoteValueBase, number>> = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
};

/** All base note values, longest first. */
export const NOTE_VALUE_BASES: ReadonlyArray<NoteValueBase> = [
  'whole',
  'half',
  'quarter',
  'eighth',
  '16th',
  '32nd',
  '64th',
];

/**
 * Default MusicXML `<divisions>` per quarter note.
 *
 * 960 is divisible by 64 (so every representable {@link NoteValue}, including
 * a double-dotted 64th = 7/64 quarter, maps to an integer division count) and
 * by 3 (leaving headroom for future triplet support).
 */
export const DEFAULT_DIVISIONS = 960;

/**
 * Returns the exact duration of a note value in PPQ (quarter note = 1.0).
 *
 * @param value Note value to measure.
 * @returns Duration in PPQ; e.g. dotted quarter = 1.5, double-dotted half = 3.5.
 */
export function noteValueToPpq(value: NoteValue): number {
  // 0 dots -> x1, 1 dot -> x1.5, 2 dots -> x1.75.
  const written = NOTE_VALUE_BASE_PPQ[value.base] * (2 - 2 ** -value.dots);
  return value.tuplet ? written * (value.tuplet.normal / value.tuplet.actual) : written;
}

/**
 * Finds the nearest representable {@link NoteValue} for a PPQ duration.
 *
 * Searches all 21 base/dot combinations (double-dotted whole = 7.0 PPQ down
 * to plain 64th = 0.0625 PPQ); durations outside that range clamp to the
 * nearest extreme. When two candidates are equally close, the one with fewer
 * dots wins (e.g. 1.25 PPQ -> quarter, not dotted quarter).
 *
 * @param ppq Duration in PPQ (quarter note = 1.0); must be finite and > 0.
 * @returns The closest representable note value.
 * @throws RangeError If `ppq` is not a finite positive number.
 */
export function ppqToNoteValue(ppq: number): NoteValue {
  if (!Number.isFinite(ppq) || ppq <= 0) {
    throw new RangeError(`ppqToNoteValue: ppq must be a finite positive number, got ${ppq}`);
  }
  let best: NoteValue = { base: '64th', dots: 0 };
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const base of NOTE_VALUE_BASES) {
    for (const dots of [0, 1, 2] as const) {
      const diff = Math.abs(ppq - NOTE_VALUE_BASE_PPQ[base] * (2 - 2 ** -dots));
      // Strictly closer wins; on a tie the candidate with fewer dots wins.
      if (diff < bestDiff - PPQ_EPSILON || (diff < bestDiff + PPQ_EPSILON && dots < best.dots)) {
        best = { base, dots };
        bestDiff = diff;
      }
    }
    const triplet: NoteValue = { base, dots: 0, tuplet: { actual: 3, normal: 2 } };
    const diff = Math.abs(ppq - noteValueToPpq(triplet));
    if (diff < PPQ_EPSILON) return triplet;
  }
  return best;
}

/** Time signature of a measure. */
export interface NotatedTimeSig {
  /** Beats per measure (MusicXML `<beats>`), e.g. 6 in 6/8. */
  beats: number;
  /** Beat unit (MusicXML `<beat-type>`), e.g. 8 in 6/8. */
  beatUnit: number;
}

/**
 * Returns the length of one measure of a time signature in PPQ.
 *
 * @param timeSig Time signature to measure.
 * @returns Measure length in PPQ; e.g. 4/4 -> 4.0, 6/8 -> 3.0.
 */
export function timeSigLengthPpq(timeSig: NotatedTimeSig): number {
  return timeSig.beats * (4 / timeSig.beatUnit);
}

/**
 * Beat-group length used for split/rest boundaries: the denominator beat
 * (4 / beatUnit) for simple meters; three of them (the dotted beat) for
 * compound meters (beatUnit >= 8 with beats divisible by 3, e.g. 6/8 -> 1.5).
 */
export function beatGroupPpq(timeSig: NotatedTimeSig): number {
  const beatLen = 4 / timeSig.beatUnit;
  const compound = timeSig.beatUnit >= 8 && timeSig.beats % 3 === 0;
  return compound ? beatLen * 3 : beatLen;
}

/**
 * Converts a PPQ position or duration to integral MusicXML divisions.
 *
 * @param ppq Value in PPQ (quarter note = 1.0).
 * @param divisions Divisions per quarter note (see {@link NotatedScore.divisions}).
 * @returns The value in divisions, rounded to the nearest integer.
 */
export function ppqToDivisions(ppq: number, divisions: number): number {
  return Math.round(ppq * divisions);
}

/** Discriminates sounding notes from rests. */
export type NotatedEventKind = 'note' | 'rest';

/** Voice number within a staff (MusicXML `<voice>`, 1-based). */
export type NotatedVoiceNumber = 1 | 2 | 3 | 4;

/**
 * One quantized event (note, chord, or rest) on a staff.
 *
 * Tie semantics are per-event, not per-pitch: the quantizer only splits
 * events as a whole (at barlines or beat-group boundaries), so when a chord
 * is tied, every pitch of the chord is tied. The serializer must emit
 * `<tie>`/`<tied>` on each `<note>` of the chord when the flags are set.
 */
export interface NotatedEvent {
  /** Whether this event is a sounding note/chord or a rest. */
  kind: NotatedEventKind;
  /**
   * MIDI note numbers (0-127), ascending. At least one entry for
   * `kind: 'note'` (more than one = chord); empty for `kind: 'rest'`.
   */
  pitches: number[];
  /** Voice this event belongs to (matches the enclosing {@link NotatedVoice}). */
  voice: NotatedVoiceNumber;
  /** Absolute quantized onset in PPQ (from the score origin). */
  startPpq: number;
  /**
   * Quantized display duration in PPQ. Always equals
   * `noteValueToPpq(value)`; stored redundantly so the serializer never
   * recomputes durations.
   */
  durationPpq: number;
  /** Notated duration (base value + dots) for glyph selection. */
  value: NoteValue;
  /** True when this event is tied to the next event of the same voice/pitches. */
  tieStart: boolean;
  /** True when this event continues a tie from the previous event. */
  tieStop: boolean;
  /**
   * Explicit staff assignment for grand-staff events (1 = treble, 2 = bass).
   * When absent, serializers may infer staff from pitch for hand-authored
   * fixtures.
   */
  staff?: 1 | 2;
  /**
   * Estimated piano fingering, one entry per pitch in {@link pitches} and
   * index-aligned with it (1 = thumb .. 5 = pinky). Present only when
   * fingering estimation is requested; absent leaves the note unfingered and
   * the serializer emits no `<fingering>`.
   */
  fingering?: number[];
  /**
   * True when this note is engraved on the staff opposite the hand its pitch
   * center would fall to on a grand staff (a hand cross: the left hand
   * reaching above, or the right hand below, the split). Present only when
   * fingering estimation is requested; absent means no crossing.
   */
  handCross?: boolean;
  /**
   * Editor note ids whose quantized notes produced this event (absent for
   * rests). Used only to attach display annotations to engraved notes; the
   * pipeline never writes through these ids back to MIDI data.
   */
  sourceIds?: number[];
  /** Stable clip/note/loop identities represented by this engraved event. */
  sourceIdentities?: MidiSourceIdentity[];
  /**
   * MIDI channels whose source notes produced this event (0-based, ascending,
   * absent for rests or hand-authored fixtures). Used by serializers for
   * channel-dependent display such as General MIDI percussion on channel 10.
   */
  midiChannels?: number[];
  /**
   * Representative note-on velocity of the source notes (1-127), when produced
   * from editor notes. Serializers may use this for display-only accents.
   */
  velocity?: number;
  /** Stable group id separating adjacent tuplets with the same ratio. */
  tupletGroupId?: string;
}

/** All events of one voice within one measure, in onset order. */
export interface NotatedVoice {
  /** Voice number (1-4). */
  voice: NotatedVoiceNumber;
  /**
   * Events sorted by `startPpq`, gap-free: the quantizer fills every gap
   * with explicit rests so each voice exactly covers the measure.
   */
  events: NotatedEvent[];
}

/** One measure of one part. */
export interface NotatedMeasure {
  /** Zero-based measure index within the part. */
  index: number;
  /** Absolute measure start in PPQ. */
  startPpq: number;
  /** Measure length in PPQ (equals `timeSigLengthPpq(timeSig)` except for pickup measures). */
  lengthPpq: number;
  /** Time signature in effect for this measure. */
  timeSig: NotatedTimeSig;
  /** Per-voice event lists, sorted by ascending voice number. */
  voices: NotatedVoice[];
}

/** Clef (staff layout) of a part; 'grand' = two staves (treble + bass). */
export type NotatedClef = 'treble' | 'bass' | 'grand';

/** One part (instrument/track) of the score. */
export interface NotatedPart {
  /** Stable part identifier (MusicXML part id, e.g. "P1"). */
  id: string;
  /** Display name shown on the first system. */
  name: string;
  /** Clef / staff layout for the part. */
  clef: NotatedClef;
  /** Measures in score order; every part has the same measure grid. */
  measures: NotatedMeasure[];
}

/**
 * Chord symbol displayed above the staff (MusicXML `<harmony>`).
 *
 * Field encodings follow libsonare conventions: `rootPc`/`bassPc` are
 * pitch classes 0-11 with C = 0 (the `PitchClass` enum), and `quality` is an
 * audio-domain `ChordQuality` ordinal (Major = 0, Minor = 1, ...). Note that
 * `ProjectChordSymbol.quality` (annotation metadata) is shifted by one
 * (0 = unknown, 1 = major, ...); convert before calling `annotateChords`.
 */
export interface NotatedChordSymbol {
  /** Absolute position in PPQ where the symbol appears. */
  ppq: number;
  /** Display text, e.g. "Cmaj7" (matches libsonare `Chord.name`). */
  text: string;
  /** Root pitch class 0-11 (C = 0). */
  rootPc?: number;
  /** libsonare audio `ChordQuality` ordinal (Major = 0, Minor = 1, ...). */
  quality?: number;
  /** Slash-bass pitch class 0-11, present only for slash chords. */
  bassPc?: number;
  /** Non-intrinsic root-relative chord tones (0-11), such as 9, 11 and 13. */
  extensions?: number[];
  /** Intrinsic tones of `quality` (0-11) the chord does not sound. */
  omissions?: number[];
  /** Optional roman-numeral label (e.g. "V") from functional analysis. */
  romanNumeral?: string;
}

/** Right barline style for a notated measure. */
export type NotatedBarlineStyle = 'regular' | 'double' | 'final';

/** Repeat marks attached to a measure boundary. */
export type NotatedRepeatMark = 'start' | 'end' | 'start-end';

/** Explicit layout break before a measure. */
export type NotatedMeasureBreak = 'system' | 'page';

/** Textual tempo/change directive such as "rit.", "accel." or "a tempo". */
export interface NotatedTempoText {
  /** Display text shown above the staff. */
  text: string;
  /** Optional playback tempo at the same measure, in BPM. */
  bpm?: number;
  /** Offset from the containing measure start in PPQ. */
  offsetPpq?: number;
}

/** One exact metronome/playback tempo location inside a measure. */
export interface NotatedTempoMark {
  /** Quarter-note BPM used by playback and converted for the display beat unit. */
  bpm: number;
  /** Offset from the containing measure start in PPQ. */
  offsetPpq: number;
}

/** General text direction displayed above the staff. */
export interface NotatedMeasureText {
  /** Text shown in the score, e.g. "Solo", "pizz.", "Cue". */
  text: string;
  /** Optional vertical offset in MusicXML tenths. */
  defaultY?: number;
}

/** MusicXML lyric syllabic value. */
export type NotatedLyricSyllabic = 'single' | 'begin' | 'middle' | 'end';

/** Lyric syllable attached to the first note event at an absolute PPQ. */
export interface NotatedLyric {
  /** Absolute PPQ position of the note attack receiving this lyric. */
  ppq: number;
  /** Lyric syllable or word shown under the staff. */
  text: string;
  /** Verse number (`<lyric number>`), 1-based. Omitted means serializer order. */
  verse?: number;
  /** Syllabic position for hyphenated lyrics. Defaults to `single`. */
  syllabic?: NotatedLyricSyllabic;
  /** Emits a MusicXML lyric extend mark for melisma. */
  extend?: boolean;
  /** Optional target part id; omitted attaches to the first matching part. */
  partId?: string;
}

/** Multi-measure rest span starting at a measure. */
export interface NotatedMultiMeasureRest {
  /** Number of consecutive empty measures represented by the start measure. */
  count: number;
}

/** Score-level bibliographic metadata (MusicXML `<work>` / `<identification>`). */
export interface ScoreMetadata {
  /** Work title (MusicXML `<work-title>`); omitted or empty = no title. */
  title?: string;
  /** Composer credit (MusicXML `<creator type="composer">`). */
  composer?: string;
  /** Part name for extracted part scores or headers. */
  partName?: string;
}

/** The complete display-only score handed to the MusicXML serializer. */
export interface NotatedScore {
  /** Parts in display order (top staff first). */
  parts: NotatedPart[];
  /** Optional bibliographic metadata (title / composer) for the score header. */
  metadata?: ScoreMetadata;
  /**
   * Key signature as MusicXML `<fifths>`: positive = sharps, negative =
   * flats, 0 = C major / A minor. Range -7..7.
   */
  keyFifths: number;
  /** MusicXML divisions per quarter note (see {@link DEFAULT_DIVISIONS}). */
  divisions: number;
  /** Optional chord symbols, sorted by `ppq`, shared by all parts. */
  chordSymbols?: NotatedChordSymbol[];
  /** Optional right barline style overrides, keyed by zero-based measure index. */
  measureBarlines?: Readonly<Record<number, NotatedBarlineStyle>>;
  /** Optional repeat marks, keyed by zero-based measure index. */
  measureRepeats?: Readonly<Record<number, NotatedRepeatMark>>;
  /** Optional layout breaks before a measure, keyed by zero-based measure index. */
  measureBreaks?: Readonly<Record<number, NotatedMeasureBreak>>;
  /** Optional rehearsal/section labels, keyed by zero-based measure index. */
  measureRehearsals?: Readonly<Record<number, string>>;
  /** Optional metronome tempo marks in BPM, keyed by zero-based measure index. */
  measureTempos?: Readonly<Record<number, number>>;
  /** Exact tempo marks (including mid-measure changes), keyed by measure index. */
  measureTempoMarks?: Readonly<Record<number, ReadonlyArray<NotatedTempoMark>>>;
  /** Optional key signature changes in fifths, keyed by zero-based measure index. */
  measureKeyFifths?: Readonly<Record<number, number>>;
  /** Optional textual tempo/change directives, keyed by zero-based measure index. */
  measureTempoTexts?: Readonly<Record<number, NotatedTempoText | ReadonlyArray<NotatedTempoText>>>;
  /** Optional general text directions, keyed by zero-based measure index. */
  measureTexts?: Readonly<Record<number, ReadonlyArray<NotatedMeasureText>>>;
  /** Optional lyric syllables resolved to note attacks by PPQ. */
  lyrics?: ReadonlyArray<NotatedLyric>;
  /** Optional multi-measure rest spans, keyed by zero-based start measure index. */
  multiMeasureRests?: Readonly<Record<number, NotatedMultiMeasureRest>>;
  /**
   * Optional display annotations keyed by editor note id, resolved against
   * {@link NotatedEvent.sourceIds}. Ids matching no event (e.g. annotations
   * of deleted notes) are ignored by the serializer.
   */
  noteAnnotations?: Readonly<Record<number, ScoreNoteAnnotation>>;
  /**
   * Engraving-only transpose in semitones: written pitches are shifted by this
   * amount from the sounding (MIDI) pitch. Serialized as a MusicXML
   * `<transpose>` so the file still sounds at the MIDI pitch.
   */
  transposeSemitones?: number;
}

function hasMeasureEntry<T>(
  entries: Readonly<Record<number, T>> | undefined,
  index: number,
): boolean {
  return entries !== undefined && Object.hasOwn(entries, index);
}

/**
 * True when engraving metadata requires a measure to remain structurally
 * visible instead of being folded into a multi-measure rest.
 */
export function measureHasMultiRestStructure(
  score: NotatedScore,
  measures: ReadonlyArray<NotatedMeasure>,
  index: number,
): boolean {
  const measure = measures[index];
  if (!measure) return true;
  const previous = measures[index - 1];
  if (
    previous &&
    (previous.timeSig.beats !== measure.timeSig.beats ||
      previous.timeSig.beatUnit !== measure.timeSig.beatUnit)
  ) {
    return true;
  }
  if (
    hasMeasureEntry(score.measureKeyFifths, index) ||
    hasMeasureEntry(score.measureTempos, index) ||
    hasMeasureEntry(score.measureTempoMarks, index) ||
    hasMeasureEntry(score.measureTempoTexts, index) ||
    hasMeasureEntry(score.measureRehearsals, index) ||
    hasMeasureEntry(score.measureTexts, index) ||
    hasMeasureEntry(score.measureRepeats, index) ||
    hasMeasureEntry(score.measureBarlines, index) ||
    hasMeasureEntry(score.measureBreaks, index)
  ) {
    return true;
  }
  const endPpq = measure.startPpq + measure.lengthPpq;
  return (
    score.chordSymbols?.some(
      (symbol) => symbol.ppq >= measure.startPpq - PPQ_EPSILON && symbol.ppq < endPpq - PPQ_EPSILON,
    ) === true ||
    score.lyrics?.some(
      (lyric) => lyric.ppq >= measure.startPpq - PPQ_EPSILON && lyric.ppq < endPpq - PPQ_EPSILON,
    ) === true
  );
}
