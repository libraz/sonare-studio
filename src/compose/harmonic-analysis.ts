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
  type ChordTimeline,
  chordToRoman,
  detectCadences,
  detectModulations,
  type KeyRelation,
  type KeyScale,
  type PivotChord,
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

/** A stretch of the chord track read in one key. */
export interface KeySpan {
  /** First PPQ of the span. */
  startPpq: number;
  /** End of the span, exclusive. */
  endPpq: number;
  /** The key the span is read in. */
  key: KeyScale;
  /**
   * How this key relates to the previous span's, when the two stand in one of
   * the named relations. Absent on the first span.
   */
  modulation?: KeyRelation;
  /** The chord the modulation turned on, when one reads in both keys. */
  pivot?: PivotChord;
}

/** The full read-only analysis of one chord track. */
export interface HarmonicAnalysis {
  /**
   * Annotations keyed by the annotated symbol's absolute `startPpq`, so a lane
   * that already positions bands by start can look one up without searching.
   * Symbols with nothing to report are absent.
   */
  byStartPpq: ReadonlyMap<number, ChordAnnotation>;
  /** Cadences in time order. */
  cadences: CadenceMark[];
  /**
   * The keys the track passes through, in time order — empty when it does not
   * modulate, so a display draws nothing rather than a single band saying what
   * the project already declares.
   */
  keySpans: KeySpan[];
}

/** Runs a libcantus call that may throw; undefined signals "no result". */
function tryEval<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Identity of a chord as read in a key, so repeats of the same chord are
 * analyzed once. The key is part of the identity: on a track that modulates the
 * same chord reads differently on either side of the boundary.
 */
function readingIdentity(chord: ChordData, key: KeyScale): string {
  const shape = `${chord.rootPc}:${chord.quality}:${chord.intervals.join(',')}:${chord.bassPc ?? -1}`;
  return `${key.rootPc}/${key.modeMask12}|${shape}`;
}

/** Whether two keys name the same root and scale. */
function sameKey(a: KeyScale, b: KeyScale): boolean {
  return a.rootPc === b.rootPc && a.modeMask12 === b.modeMask12;
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

/**
 * The keys the track passes through, empty when it does not modulate.
 *
 * Detection never overrules the declared key. Asked about a whole progression
 * it answers with the key the chords fit best, which is not the key the piece
 * is written in — a blues answers with its subdominant, an Aeolian progression
 * with its relative major — and the declared key is what the user wrote. What
 * detection does read reliably is that the key *changed* partway through. So a
 * single detected region means "no modulation": the declared key stands for the
 * whole track and the reading is exactly what it was before. Two or more mean
 * the track modulates, and only the spans after the first take a detected key.
 */
function keySpansOf(timeline: ChordTimeline, key: KeyScale): KeySpan[] {
  const regions = tryEval(() => detectModulations(timeline.segments)) ?? [];
  if (regions.length < 2) return [];
  return regions.map((region, index) => {
    const span: KeySpan = {
      startPpq: region.startBeat,
      endPpq: region.endBeat,
      key: index === 0 ? key : region.key,
    };
    // Both fields describe the move away from the previous region's *detected*
    // key. That is the key the span before is read in everywhere except across
    // the first boundary, where the declared key may have replaced a different
    // detection, so there they are dropped rather than reported against a key
    // nothing is read in.
    if (index > 1 || (index === 1 && sameKey(regions[0].key, key))) {
      if (region.modulation !== undefined) span.modulation = region.modulation;
      if (region.pivot !== undefined) span.pivot = region.pivot;
    }
    return span;
  });
}

/** The key a position is read in; the declared key when the track has no spans. */
function keyAtPpq(spans: ReadonlyArray<KeySpan>, declared: KeyScale, ppq: number): KeyScale {
  let current = declared;
  for (const span of spans) {
    if (span.startPpq > ppq) break;
    current = span.key;
  }
  return current;
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

/** Cadences over the whole track, each span read in the key in force over it. */
function cadenceMarks(
  timeline: ChordTimeline,
  spans: ReadonlyArray<KeySpan>,
  key: KeyScale,
): CadenceMark[] {
  // detectCadences answers for one key, so a modulating track is asked once per
  // span and each answer is cut down to the stretch that span covers. Without a
  // modulation the declared key answers for the whole track.
  const scopes: ReadonlyArray<KeySpan> =
    spans.length === 0
      ? [{ startPpq: Number.NEGATIVE_INFINITY, endPpq: Number.POSITIVE_INFINITY, key }]
      : spans;
  const out: CadenceMark[] = [];
  for (const scope of scopes) {
    const hits = tryEval(() => detectCadences(timeline, scope.key)) ?? [];
    for (const hit of hits) {
      if (hit.atBeat < scope.startPpq || hit.atBeat >= scope.endPpq) continue;
      const type = displayedCadence(hit.cadence);
      if (type !== undefined) out.push({ atPpq: hit.atBeat, type });
    }
  }
  return out;
}

/**
 * Analyzes a chord track for display.
 *
 * @param symbols The project chord track (absolute PPQ regions).
 * @param key The key the progression is declared in; see {@link keySpansOf} for
 *   how a modulation is read against it.
 * @returns Per-symbol annotations, the cadences found between symbols, and the
 *   keys the track passes through.
 */
export function analyzeHarmony(
  symbols: ReadonlyArray<EditorChordSymbol>,
  key: KeyScale,
): HarmonicAnalysis {
  const timeline = tryEval(() => buildChordTimeline(symbols));
  const keySpans = timeline === undefined ? [] : keySpansOf(timeline, key);
  const byStartPpq = new Map<number, ChordAnnotation>();
  // A progression repeats its chords; the reading depends only on the chord and
  // the key it is read in, so memoize it by that pair across the track.
  const cache = new Map<string, ChordAnnotation | undefined>();
  for (const symbol of symbols) {
    const chord = tryEval(() => editorChordToChord(symbol));
    if (chord === undefined) continue;
    const localKey = keyAtPpq(keySpans, key, symbol.startPpq);
    const identity = readingIdentity(chord, localKey);
    let annotation = cache.get(identity);
    if (!cache.has(identity)) {
      annotation = annotationFor(chord, localKey);
      cache.set(identity, annotation);
    }
    if (annotation !== undefined) byStartPpq.set(symbol.startPpq, annotation);
  }
  return {
    byStartPpq,
    cadences: timeline === undefined ? [] : cadenceMarks(timeline, keySpans, key),
    keySpans,
  };
}
