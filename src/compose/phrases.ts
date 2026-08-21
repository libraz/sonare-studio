/**
 * Phrase structure: where the music breathes, which cadences carry the piece,
 * and how its bars group into hyperbars.
 *
 * A thin adapter over libcantus's {@link phrasesFromTimeline},
 * {@link structuralCadences} and {@link hypermeter}. The library reconciles
 * three independent kinds of evidence — the harmony's cadences, the melody's
 * rests and held notes, and where material starts repeating — against how
 * regular the resulting phrase lengths come out. This module's job is input
 * hygiene and positioning:
 *
 *  - percussion tracks are dropped ({@link harmonicTracksOnly}), because drum
 *    hits carry neither the melody's breathing nor the harmony's arrivals;
 *  - the chord track is preferred over an inferred timeline when the project has
 *    one, so phrasing follows the harmony the composer wrote rather than a
 *    reading of it;
 *  - the project meter map is handed over whole, so bar lines, hypermetric
 *    downbeats and the expected phrase length all follow the signature in force
 *    rather than the one the piece opened in;
 *  - the library's prose rationale is not carried across. It is English-only, so
 *    a cadence is reported as the two numbers that prose recites — how much of
 *    the piece it closes and how well evidenced its phrase is — and the display
 *    writes those in its own language;
 *  - beats map to PPQ with coefficient 1 (1 PPQ = one quarter note).
 *
 * Read-only analysis: nothing here writes to the project. Callers must flatten
 * each track's clips to absolute-timeline PPQ before passing notes. Pure module.
 */

import {
  type ChordTimelineOptions,
  chordTimelineFromNotes,
  hypermeter,
  isLibcantusError,
  type Phrase,
  type PhraseOptions,
  type PhraseSignal,
  phrasesFromTimeline,
  structuralCadences,
} from '@libraz/libcantus';
import type { EditorChordSymbol } from '@/project/chords';
import { toMeterMap } from '@/project/time-signature';
import type { TimeSignatureSegment } from '@/project/types';
import { buildChordTimeline } from './chord-at-tick';
import { type CadenceType, displayedCadence } from './harmonic-analysis';
import { editorNotesToNoteEvents } from './notes-io';
import { harmonicTracksOnly, type TrackWithNotes } from './tracks';

/** One phrase of the piece, positioned in absolute PPQ. */
export interface DetectedPhrase {
  /** Inclusive start in absolute PPQ (0 when the phrase opens on a pickup). */
  startPpq: number;
  /** Exclusive end in absolute PPQ. */
  endPpq: number;
  /**
   * The cadence closing the phrase, when one does and the editor has a name for
   * it. A phrase closed by a cadence type the editor does not name reads as
   * having no cadence here, matching the chord lane.
   */
  cadence?: { atPpq: number; type: CadenceType };
  /** Why the closing boundary was placed here, strongest evidence first. */
  signals: PhraseSignal[];
  /** How well evidenced the phrase is, in [0, 1]. */
  confidence: number;
  /** How much structural weight the closing cadence carries, in [0, 1]. */
  structuralWeight: number;
}

/** A cadence ranked by how much of the piece it closes. */
export interface RankedCadence {
  /** Index of the phrase this cadence closes, in {@link PhraseReport.phrases}. */
  phraseIndex: number;
  /** Absolute PPQ the cadence arrives on. */
  atPpq: number;
  /** Absolute PPQ the phrase it closes ends at. */
  endPpq: number;
  type: CadenceType;
  /** Structural weight in [0, 1], heaviest first in the report. */
  weight: number;
  /** How well evidenced the phrase it closes is, in [0, 1]. */
  confidence: number;
}

/** How the piece's bars group above the bar line. */
export interface HypermeterReading {
  /** Bars per hyperbar. */
  groupBars: number;
  /** Absolute PPQ of each hypermetric downbeat, in time order. */
  downbeatPpqs: number[];
  /** How much the music supports the grouping, in [0, 1]. */
  confidence: number;
}

/** The phrase analysis shaped for the editor. */
export interface PhraseReport {
  /** Phrases in time order; they abut and cover the whole span. */
  phrases: DetectedPhrase[];
  /** The cadences closing those phrases, heaviest first. */
  cadences: RankedCadence[];
  /** The hyperbar grouping, or null when there was nothing to read. */
  hypermeter: HypermeterReading | null;
  /** Names of the percussion tracks excluded from the analysis. */
  excludedTrackNames: string[];
  /**
   * True when the piece holds more notes than the phrase reading can compare.
   *
   * Repetition is one of the three kinds of evidence the reading weighs, and
   * finding it means comparing the piece against itself, which grows faster
   * than the piece does; past a few thousand notes the library refuses rather
   * than running unbounded. The rest of the analysis is unaffected, so this is
   * reported instead of thrown: a long arrangement still gets its conflicts,
   * its tension curve and its figures, and is told which reading it did not get.
   */
  tooLongForPhrases: boolean;
}

/** An empty report carrying only what was excluded. */
function emptyReport(excludedTrackNames: string[], tooLongForPhrases = false): PhraseReport {
  return { phrases: [], cadences: [], hypermeter: null, excludedTrackNames, tooLongForPhrases };
}

/** True for the library's own "this input is larger than I will search" refusal. */
function isBudgetRefusal(error: unknown): boolean {
  return isLibcantusError(error) && error.code === 'BUDGET_EXCEEDED';
}

/**
 * Reads a piece's phrase structure from its notes and, when it has one, its
 * chord track.
 *
 * @param tracks Tracks with absolute-timeline notes (percussion dropped inside).
 * @param chords The project chord track; the harmony is inferred when empty.
 * @param timeSignatures Optional project meter map; 4/4 throughout when omitted.
 * @returns Phrases, ranked cadences, the hyperbar grouping and what was excluded.
 */
export function analyzePhrases(
  tracks: ReadonlyArray<TrackWithNotes>,
  chords: ReadonlyArray<EditorChordSymbol> = [],
  timeSignatures?: ReadonlyArray<TimeSignatureSegment>,
): PhraseReport {
  const { harmonic, excluded } = harmonicTracksOnly(tracks);
  const excludedTrackNames = excluded.map((item) => item.track.name);
  const notes = editorNotesToNoteEvents(harmonic.flatMap((item) => item.notes));
  if (notes.length === 0) return emptyReport(excludedTrackNames);

  const meters =
    timeSignatures !== undefined && timeSignatures.length > 0
      ? toMeterMap(timeSignatures)
      : undefined;
  const opts: PhraseOptions = {};
  if (meters !== undefined) opts.meters = meters;

  // A written chord track states the harmony; without one it has to be read
  // back out of the notes, which is what the library would do anyway.
  const timelineOpts: ChordTimelineOptions = {};
  if (meters !== undefined) timelineOpts.meters = meters;
  const timeline =
    chords.length > 0
      ? buildChordTimeline(chords)
      : chordTimelineFromNotes(notes, timelineOpts).timeline;

  let phrases: Phrase[];
  try {
    phrases = phrasesFromTimeline(timeline, notes, opts);
  } catch (error) {
    // Only the library's size refusal is an answer; anything else is a fault
    // and stays a fault.
    if (!isBudgetRefusal(error)) throw error;
    return emptyReport(excludedTrackNames, true);
  }
  const ranked = structuralCadences(phrases);
  const grouping = hypermeter(notes, meters, {});

  return {
    phrases: phrases.map<DetectedPhrase>((phrase) => {
      const type = phrase.cadence === null ? undefined : displayedCadence(phrase.cadence.cadence);
      return {
        // A phrase opening on a pickup starts before bar one; the timeline has
        // no room for negative time, so the opening phrase starts at zero.
        startPpq: Math.max(0, phrase.startBeat),
        endPpq: phrase.endBeat,
        ...(phrase.cadence === null || type === undefined
          ? {}
          : { cadence: { atPpq: phrase.cadence.atBeat, type } }),
        signals: [...phrase.signals],
        confidence: phrase.confidence,
        structuralWeight: phrase.structuralWeight,
      };
    }),
    cadences: ranked.flatMap<RankedCadence>((cadence) => {
      const type = displayedCadence(cadence.cadence);
      return type === undefined
        ? []
        : [
            {
              phraseIndex: cadence.phraseIndex,
              atPpq: cadence.atBeat,
              endPpq: cadence.endBeat,
              type,
              weight: cadence.weight,
              // The weight says how much of the piece the cadence closes; the
              // confidence says how well evidenced the phrase closing there is.
              // Both come from the phrase, and the ranking only carries the
              // first, so the second is read back off the phrase it indexes.
              confidence: phrases[cadence.phraseIndex]?.confidence ?? 0,
            },
          ];
    }),
    hypermeter: {
      groupBars: grouping.groupBars,
      downbeatPpqs: [...grouping.downbeats],
      confidence: grouping.confidence,
    },
    excludedTrackNames,
    tooLongForPhrases: false,
  };
}
