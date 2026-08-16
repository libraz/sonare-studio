/**
 * Functional-harmony annotation for the editor's chord track: applied
 * (secondary) dominants, borrowed chords, and cadences.
 *
 * Read-only display analysis — it never rewrites the chord track. The chord
 * track is symbolic data, so the reading comes from libcantus rather than the
 * audio-domain engine, and every library call is guarded: an odd chord or an
 * odd key degrades to "no annotation" rather than breaking the lane drawing it.
 *
 * PPQ maps to beats with coefficient 1 (see {@link buildChordTimeline}), so a
 * cadence's beat is already the absolute PPQ it lands on.
 *
 * Pure module (no Vue/Pinia).
 */

import {
  type BorrowedSource,
  borrowedSource,
  type CadenceResult,
  type ChordData,
  chordToRoman,
  detectCadences,
  type KeyScale,
} from '@libraz/libcantus';
import type { EditorChordSymbol } from '@/project/chords';
import { buildChordTimeline } from './chord-at-tick';
import { editorChordToChord } from './chord-io';

/** A cadence type as libcantus names it (the null case is "no cadence"). */
type LibraryCadenceType = NonNullable<CadenceResult['type']>;

/** The cadence types the editor has a label for; libcantus names more. */
const DISPLAYED_CADENCE_TYPES = [
  'authentic',
  'plagal',
  'half',
  'deceptive',
] as const satisfies ReadonlyArray<LibraryCadenceType>;

/** A recognized cadence type the editor can name. */
export type CadenceType = (typeof DISPLAYED_CADENCE_TYPES)[number];

/**
 * The type each of libcantus's cadence types is read as. A phrygian cadence is
 * a species of half cadence and is reported in place of one, so it reads as
 * `'half'`; every other type reads as itself. Keyed by the library's union, so
 * a type added there fails to compile until it is given a reading.
 */
const CADENCE_READING: Readonly<Record<LibraryCadenceType, LibraryCadenceType>> = {
  authentic: 'authentic',
  plagal: 'plagal',
  half: 'half',
  deceptive: 'deceptive',
  phrygian: 'half',
  modal: 'modal',
};

/** Where a recognized non-diatonic chord was borrowed from. */
export type BorrowedKind = Exclude<BorrowedSource, null>;

/** What one chord symbol adds to its display beyond its name. */
export interface ChordAnnotation {
  /** Applied-dominant numeral such as `V7/V`, when the chord reads as one. */
  appliedRoman?: string;
  /** Borrowing source, when the chord is a modal interchange or Neapolitan. */
  borrowed?: BorrowedKind;
}

/** One cadence, placed at the absolute PPQ its resolving chord starts on. */
export interface CadenceMark {
  atPpq: number;
  type: CadenceType;
}

/** The full read-only analysis of one chord track in one key. */
export interface HarmonicAnalysis {
  /**
   * Annotations keyed by the annotated symbol's absolute `startPpq`, so a lane
   * that already positions bands by start can look one up without searching.
   * Symbols with nothing to report are absent.
   */
  byStartPpq: ReadonlyMap<number, ChordAnnotation>;
  /** Cadences in time order. */
  cadences: CadenceMark[];
}

/** Runs a libcantus call that may throw; undefined signals "no result". */
function tryEval<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Identity of a chord, so repeats of the same chord are analyzed once. */
function chordIdentity(chord: ChordData): string {
  return `${chord.rootPc}:${chord.quality}:${chord.intervals.join(',')}:${chord.bassPc ?? -1}`;
}

/** The annotation for one chord, or undefined when it has nothing to report. */
function annotationFor(chord: ChordData, key: KeyScale): ChordAnnotation | undefined {
  const annotation: ChordAnnotation = {};
  // The numeral spends its slash on applied chords only: inversions render as
  // figured-bass suffixes and a non-chord-tone bass is dropped, so a slash in
  // the applied spelling is exactly the "this tonicizes something" reading.
  const roman = tryEval(() => chordToRoman(chord, key, { applied: true }));
  if (roman?.includes('/') === true) annotation.appliedRoman = roman;
  const borrowed = tryEval(() => borrowedSource(chord, key));
  if (borrowed !== undefined && borrowed !== null) annotation.borrowed = borrowed;
  return annotation.appliedRoman === undefined && annotation.borrowed === undefined
    ? undefined
    : annotation;
}

/** Whether a cadence type is one of the types the editor can name. */
function isDisplayedCadence(type: LibraryCadenceType): type is CadenceType {
  return DISPLAYED_CADENCE_TYPES.some((displayed) => displayed === type);
}

/** How a detected cadence reads on the lane, or undefined when it has no label. */
function displayedCadence(cadence: CadenceResult): CadenceType | undefined {
  if (cadence.type === null) return undefined;
  const reading = CADENCE_READING[cadence.type];
  // `'modal'` (the bVII-to-I arrival) has no label of its own, so it goes unmarked.
  return isDisplayedCadence(reading) ? reading : undefined;
}

/**
 * Analyzes a chord track for display.
 *
 * @param symbols The project chord track (absolute PPQ regions).
 * @param key The key the progression is read in.
 * @returns Per-symbol annotations plus the cadences found between symbols.
 */
export function analyzeHarmony(
  symbols: ReadonlyArray<EditorChordSymbol>,
  key: KeyScale,
): HarmonicAnalysis {
  const byStartPpq = new Map<number, ChordAnnotation>();
  // A progression repeats its chords; the reading depends only on the chord and
  // the key, so memoize it by chord identity across the track.
  const cache = new Map<string, ChordAnnotation | undefined>();
  for (const symbol of symbols) {
    const chord = tryEval(() => editorChordToChord(symbol));
    if (chord === undefined) continue;
    const identity = chordIdentity(chord);
    let annotation = cache.get(identity);
    if (!cache.has(identity)) {
      annotation = annotationFor(chord, key);
      cache.set(identity, annotation);
    }
    if (annotation !== undefined) byStartPpq.set(symbol.startPpq, annotation);
  }
  const hits = tryEval(() => detectCadences(buildChordTimeline(symbols), key)) ?? [];
  return {
    byStartPpq,
    cadences: hits.flatMap((hit) => {
      const type = displayedCadence(hit.cadence);
      return type === undefined ? [] : [{ atPpq: hit.atBeat, type }];
    }),
  };
}
