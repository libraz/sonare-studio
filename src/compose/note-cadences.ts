/**
 * Cadence arrivals, attached to the notes that sound them.
 *
 * Two sources, deliberately unequal in standing:
 *
 *  - a chord track states the harmony, so its cadences are reported plainly.
 *    They are read through {@link chordTrackCadences}, the same reading the
 *    chord lane draws, rather than detected a second time here;
 *  - without one the harmony has to be read back out of the notes, and that
 *    reading is only worth reporting when it looks like it tracked a harmonic
 *    rhythm at all. Dense arpeggiated polyphony spreads one chord's tones
 *    across many windows and the inference answers with a segmentation whose
 *    lengths run from one beat to thirty; the chords it names are artifacts of
 *    the pitch-class histogram, and the cadences between them describe a
 *    progression the piece never plays. {@link segmentationQuality} measures
 *    how much of the piece the reading covers with segments of one consistent
 *    length, and readings below {@link SEGMENT_REGULARITY_MIN} are dropped
 *    whole rather than shown with a caveat.
 *
 * What survives the gate is still a reading, so callers mark it as inferred the
 * way an estimated key is marked.
 *
 * A cadence lands on the notes that arrive with it, never on everything its
 * resolving chord covers: a resolving segment runs to fifteen beats on real
 * material, and a line repeated under every note of it says nothing about the
 * note it is attached to.
 *
 * Pure module (no Vue/Pinia); libcantus calls are guarded so unexpected input
 * degrades to "no cadence" instead of throwing at the caller.
 */

import {
  type ChordSegment,
  type ChordTimelineOptions,
  type ChordTimelineResult,
  chordTimelineFromNotes,
  detectCadences,
  type KeyScale,
  type MeterMap,
  type NoteEvent,
  phrasesFromTimeline,
  structuralCadences,
} from '@libraz/libcantus';
import type { EditorChordSymbol } from '@/project/chords';
import { meterBarLengthPpq, meterBeatLengthPpq, timeSignatureAt } from '@/project/time-signature';
import type { EditorNote, TimeSignatureSegment } from '@/project/types';
import { type CadenceType, chordTrackCadences, displayedCadence } from './harmonic-analysis';

/** One cadence arrival on the shared timeline. */
export interface CadenceArrival {
  /** Absolute PPQ the cadence arrives on (PPQ maps to beats with coefficient 1). */
  atPpq: number;
  type: CadenceType;
}

/** What a note's own cadence line says. */
export interface NoteCadence {
  type: CadenceType;
  /**
   * True when the harmony was read out of the notes rather than stated by a
   * chord track, so the display can hedge it.
   */
  inferred: boolean;
}

/** How well an inferred chord segmentation tracked a harmonic rhythm. */
export interface SegmentationQuality {
  /**
   * Share of the analyzed span, in [0, 1], covered by segments whose length is
   * within a factor of {@link TYPICAL_LENGTH_FACTOR} of the median segment.
   *
   * Duration-weighted rather than counted, because what disqualifies a reading
   * is not a handful of odd segments but a few enormous ones swallowing the
   * piece while the typical segment stays short.
   */
  regularity: number;
  /** Median segment length in beats. */
  medianBeats: number;
  /** The expected chord length the reading is measured against, in beats. */
  harmonicRhythmBeats: number;
  /** How many segments the reading found. */
  segmentCount: number;
}

/** The inferred reading of a piece's cadences, and what it was judged on. */
export interface InferredCadences {
  /** The arrivals to report; empty when the reading was not trusted. */
  arrivals: CadenceArrival[];
  quality: SegmentationQuality;
  /** Whether the segmentation passed {@link isSegmentationTrustworthy}. */
  trusted: boolean;
}

/**
 * How far a segment may stand from the median length and still count as one of
 * the piece's typical chords — a factor of two either way, so a reading that
 * alternates whole bars with half bars is still regular.
 */
const TYPICAL_LENGTH_FACTOR = 2;

/**
 * Least share of the piece that must be covered by typical-length segments
 * before an inferred cadence is reported.
 *
 * Measured, not chosen by feel. On the four-voice arpeggiated toccata of BWV
 * 565 the inference answers with 139 segments of 1 to 30 beats against a median
 * of 2, and typical-length segments cover 0.419 of the piece; on homophony —
 * block chords, a broken-chord accompaniment, a ballad at one chord per two
 * bars, and a mixed 2/4/8-beat harmonic rhythm with passing tones over it — the
 * same measure comes back at 1.0. An unaccompanied single line, whose harmony
 * is not there to be read, comes back at 0.547.
 */
export const SEGMENT_REGULARITY_MIN = 0.75;

/**
 * How far the median segment may stand from the expected chord length before
 * the reading is refused as not having found a harmonic rhythm at all.
 *
 * This is a sanity guard rather than the separator: it rejects the degenerate
 * answer where dense counterpoint collapses to one or two chords spanning the
 * whole piece (a two-voice invention reads as a single 64-beat segment, 16
 * times the bar), which is perfectly "regular" and means nothing. Both the
 * suppressed and the reported material sit well inside it.
 */
const MEDIAN_RHYTHM_FACTOR = 4;

/** Runs a libcantus call that may throw; undefined signals "no result". */
function tryEval<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Maps the project meter map to libcantus's, using PPQ as the beat. */
function toMeterMap(timeSignatures: ReadonlyArray<TimeSignatureSegment>): MeterMap {
  return timeSignatures.map((segment) => ({
    startBeat: segment.startPpq,
    ts: { numerator: segment.numerator, denominator: segment.denominator },
  }));
}

/**
 * The chord length the inference is expected to find: the opening bar, which is
 * what {@link chordTimelineFromNotes} itself defaults its `harmonicRhythm` to.
 */
function harmonicRhythmOf(timeSignatures: ReadonlyArray<TimeSignatureSegment>): number {
  return meterBarLengthPpq(timeSignatures[0] ?? { numerator: 4, denominator: 4 });
}

/** Median of an ascending list; 0 for an empty one. */
function median(ascending: ReadonlyArray<number>): number {
  if (ascending.length === 0) return 0;
  const middle = (ascending.length - 1) / 2;
  const low = Math.floor(middle);
  const high = Math.ceil(middle);
  return (ascending[low] + ascending[high]) / 2;
}

/**
 * Measures how well an inferred segmentation tracked a harmonic rhythm.
 *
 * @param segments The inferred timeline's segments.
 * @param harmonicRhythmBeats The expected chord length (see {@link harmonicRhythmOf}).
 */
export function segmentationQuality(
  segments: ReadonlyArray<ChordSegment>,
  harmonicRhythmBeats: number,
): SegmentationQuality {
  const lengths = segments
    .map((segment) => segment.endBeat - segment.startBeat)
    .sort((a, b) => a - b);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const middle = median(lengths);
  const low = middle / TYPICAL_LENGTH_FACTOR - 1e-9;
  const high = middle * TYPICAL_LENGTH_FACTOR + 1e-9;
  const typical = lengths
    .filter((length) => length >= low && length <= high)
    .reduce((sum, length) => sum + length, 0);
  return {
    regularity: total > 0 ? typical / total : 0,
    medianBeats: middle,
    harmonicRhythmBeats,
    segmentCount: segments.length,
  };
}

/** Whether an inferred segmentation is worth reading cadences off. */
export function isSegmentationTrustworthy(quality: SegmentationQuality): boolean {
  if (quality.segmentCount === 0 || quality.harmonicRhythmBeats <= 0) return false;
  const ratio = quality.medianBeats / quality.harmonicRhythmBeats;
  if (ratio > MEDIAN_RHYTHM_FACTOR || ratio < 1 / MEDIAN_RHYTHM_FACTOR) return false;
  return quality.regularity >= SEGMENT_REGULARITY_MIN;
}

/**
 * Inferring a chord timeline costs tens of milliseconds on a full arrangement
 * and grows faster than the piece does, while the guidance pass that wants it
 * reruns on every edit to any of its inputs. The answer depends only on the
 * notes and the meter, so it is kept across calls under an identity built from
 * both. Two entries — enough that alternating between two clips of the same
 * project does not thrash the memo, and no more, since each entry holds a whole
 * reading. The chord-track cadences below are kept the same way.
 */
const CADENCE_MEMO_LIMIT = 2;

const timelineMemo = new Map<string, ChordTimelineResult | undefined>();

/** Identity of a note set and meter map for the timeline memo. */
function timelineIdentity(
  notes: ReadonlyArray<NoteEvent>,
  timeSignatures: ReadonlyArray<TimeSignatureSegment>,
): string {
  const meters = timeSignatures
    .map((segment) => `${segment.startPpq}/${segment.numerator}/${segment.denominator}`)
    .join(',');
  const events = notes
    .map((note) => `${note.pitch},${note.startBeat},${note.durationBeat},${note.velocity ?? ''}`)
    .join(';');
  return `${meters}|${events}`;
}

/** The inferred chord timeline for a note set, computed at most once per input. */
function memoizedTimeline(
  notes: ReadonlyArray<NoteEvent>,
  timeSignatures: ReadonlyArray<TimeSignatureSegment>,
): ChordTimelineResult | undefined {
  const identity = timelineIdentity(notes, timeSignatures);
  if (timelineMemo.has(identity)) return timelineMemo.get(identity);
  const options: ChordTimelineOptions = {};
  if (timeSignatures.length > 0) options.meters = toMeterMap(timeSignatures);
  const result = tryEval(() => chordTimelineFromNotes(notes, options));
  if (timelineMemo.size >= CADENCE_MEMO_LIMIT) {
    const oldest = timelineMemo.keys().next();
    if (!oldest.done) timelineMemo.delete(oldest.value);
  }
  timelineMemo.set(identity, result);
  return result;
}

/**
 * The cadences of an inferred timeline, ranked by how much of the piece each
 * closes when the piece is small enough for the phrase reading to rank them.
 *
 * Ranking matters here: over the whole of BWV 565 the raw pairwise detection
 * answers 37 times against the phrase reading's 11, and the ones the phrase
 * reading drops are the pairs that happen to look like a cadence between two
 * histogram artifacts. Finding phrases means comparing the piece against
 * itself, so past a few thousand notes the library refuses; the raw detection
 * is then all there is, and is used as it stands.
 */
function rankedArrivals(
  result: ChordTimelineResult,
  notes: ReadonlyArray<NoteEvent>,
  timeSignatures: ReadonlyArray<TimeSignatureSegment>,
): CadenceArrival[] {
  const options = timeSignatures.length > 0 ? { meters: toMeterMap(timeSignatures) } : {};
  const phrases = tryEval(() => phrasesFromTimeline(result.timeline, notes, options));
  const ranked = phrases === undefined ? undefined : tryEval(() => structuralCadences(phrases));
  if (ranked !== undefined) {
    return ranked.flatMap((cadence) => {
      const type = displayedCadence(cadence.cadence);
      return type === undefined ? [] : [{ atPpq: cadence.atBeat, type }];
    });
  }
  const hits = tryEval(() => detectCadences(result.timeline, result.prevailingKey)) ?? [];
  return hits.flatMap((hit) => {
    const type = displayedCadence(hit.cadence);
    return type === undefined ? [] : [{ atPpq: hit.atBeat, type }];
  });
}

/**
 * Reads a piece's cadences out of its notes, and says whether the reading is
 * trustworthy enough to show.
 *
 * @param notes Every sounding note of the piece, on the shared timeline.
 * @param timeSignatures The project meter map.
 * @returns The arrivals (empty when the reading was refused) and the
 *   segmentation measure they were judged on.
 */
export function cadencesFromNotes(
  notes: ReadonlyArray<NoteEvent>,
  timeSignatures: ReadonlyArray<TimeSignatureSegment>,
): InferredCadences {
  const harmonicRhythm = harmonicRhythmOf(timeSignatures);
  const result = notes.length === 0 ? undefined : memoizedTimeline(notes, timeSignatures);
  if (result === undefined) {
    return {
      arrivals: [],
      quality: {
        regularity: 0,
        medianBeats: 0,
        harmonicRhythmBeats: harmonicRhythm,
        segmentCount: 0,
      },
      trusted: false,
    };
  }
  const quality = segmentationQuality(result.timeline.segments, harmonicRhythm);
  const trusted = isSegmentationTrustworthy(quality);
  return {
    arrivals: trusted ? rankedArrivals(result, notes, timeSignatures) : [],
    quality,
    trusted,
  };
}

/**
 * Chord-track cadences, kept across calls the way the inferred timeline is: the
 * reading walks every symbol and every key region, which is milliseconds on a
 * long progression, and the guidance pass asking for it reruns on note edits
 * that cannot have changed it.
 */
const chordCadenceMemo = new Map<string, CadenceArrival[]>();

/**
 * Identity of a chord track as read in one key, for the cadence memo. Every
 * field the chord conversion reads is part of it — an edit that only adds an
 * extension or drops a tone changes which chord sounds, and with it where the
 * progression arrives.
 */
function chordTrackIdentity(symbols: ReadonlyArray<EditorChordSymbol>, key: KeyScale): string {
  const track = symbols
    .map(
      (symbol) =>
        `${symbol.startPpq},${symbol.endPpq},${symbol.rootPc},${symbol.quality},${symbol.bassPc ?? ''}` +
        `,${(symbol.extensions ?? []).join('.')},${(symbol.omissions ?? []).join('.')}`,
    )
    .join(';');
  return `${key.rootPc}/${key.modeMask12}|${track}`;
}

/** The cadences an authored chord track states, computed at most once per input. */
function memoizedChordCadences(
  symbols: ReadonlyArray<EditorChordSymbol>,
  key: KeyScale,
): CadenceArrival[] {
  const identity = chordTrackIdentity(symbols, key);
  const cached = chordCadenceMemo.get(identity);
  if (cached !== undefined) return cached;
  const marks = chordTrackCadences(symbols, key).map<CadenceArrival>((mark) => ({
    atPpq: mark.atPpq,
    type: mark.type,
  }));
  if (chordCadenceMemo.size >= CADENCE_MEMO_LIMIT) {
    const oldest = chordCadenceMemo.keys().next();
    if (!oldest.done) chordCadenceMemo.delete(oldest.value);
  }
  chordCadenceMemo.set(identity, marks);
  return marks;
}

/**
 * The cadence arrivals of a piece, from its chord track when it has one and
 * from its notes when it does not.
 *
 * @param symbols The project chord track; the harmony is read from the notes
 *   when it is empty.
 * @param notes Every sounding note of the piece, on the shared timeline. Pool
 *   the whole texture rather than one clip: harmony is a property of what
 *   sounds together, not of the part being edited.
 * @param key The key the progression is read in (used only by the chord-track
 *   reading; the inference searches for the key itself).
 * @param timeSignatures The project meter map.
 */
export function cadenceArrivals(
  symbols: ReadonlyArray<EditorChordSymbol>,
  notes: ReadonlyArray<NoteEvent>,
  key: KeyScale,
  timeSignatures: ReadonlyArray<TimeSignatureSegment>,
): { arrivals: CadenceArrival[]; inferred: boolean; quality?: SegmentationQuality } {
  if (symbols.length > 0) {
    return { arrivals: memoizedChordCadences(symbols, key), inferred: false };
  }
  const read = cadencesFromNotes(notes, timeSignatures);
  return { arrivals: read.arrivals, inferred: true, quality: read.quality };
}

/**
 * Half a beat of the meter in force: the width either side of an arrival within
 * which a note counts as sounding it. Wide enough to hold a chord spread across
 * the beat or a voice entering just behind the bass, narrow enough that the
 * note after the arrival is a different note.
 */
function arrivalWindowAt(
  timeSignatures: ReadonlyArray<TimeSignatureSegment>,
  atPpq: number,
): number {
  return meterBeatLengthPpq(timeSignatureAt(timeSignatures, atPpq)) / 2;
}

/**
 * Maps cadence arrivals onto the notes that sound them.
 *
 * @param notes Notes to attach to, carrying the id the result is keyed by.
 * @param absoluteStartOf Absolute PPQ of a note's onset.
 * @param arrivals The piece's cadence arrivals.
 * @param inferred Whether they were read out of the notes (see {@link NoteCadence}).
 * @param timeSignatures The project meter map (sets the arrival window).
 * @returns One entry per note that arrives on a cadence; notes away from every
 *   arrival are absent.
 */
export function cadencesByNote(
  notes: ReadonlyArray<EditorNote>,
  absoluteStartOf: (note: EditorNote) => number,
  arrivals: ReadonlyArray<CadenceArrival>,
  inferred: boolean,
  timeSignatures: ReadonlyArray<TimeSignatureSegment>,
): Map<number, NoteCadence> {
  const byNoteId = new Map<number, NoteCadence>();
  if (arrivals.length === 0) return byNoteId;
  const windows = arrivals.map((arrival) => arrivalWindowAt(timeSignatures, arrival.atPpq));
  for (const note of notes) {
    const at = absoluteStartOf(note);
    for (const [index, arrival] of arrivals.entries()) {
      if (Math.abs(at - arrival.atPpq) < windows[index]) {
        byNoteId.set(note.id, { type: arrival.type, inferred });
        break;
      }
    }
  }
  return byNoteId;
}
