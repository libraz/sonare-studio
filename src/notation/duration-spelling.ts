/**
 * Duration spelling for the display quantizer: the representable note values,
 * and the decomposition of note and rest spans into tied values split at
 * beat-group boundaries (pipeline steps 5 and 6 of the quantizer).
 */

import { NOTE_VALUE_BASES, type NoteValue, noteValueToPpq } from '@/notation/model';
import { EPSILON } from '@/notation/voice-unit';

/** A representable duration slice produced by decomposition. */
export interface DurationPiece {
  startPpq: number;
  durationPpq: number;
  value: NoteValue;
}

/** All 21 representable note values, longest first, with their PPQ lengths. */
const VALUES_DESC: ReadonlyArray<{ value: NoteValue; ppq: number }> = (() => {
  const all: Array<{ value: NoteValue; ppq: number }> = [];
  for (const base of NOTE_VALUE_BASES) {
    for (const dots of [0, 1, 2] as const) {
      const value: NoteValue = { base, dots };
      all.push({ value, ppq: noteValueToPpq(value) });
    }
    const triplet: NoteValue = { base, dots: 0, tuplet: { actual: 3, normal: 2 } };
    all.push({ value: triplet, ppq: noteValueToPpq(triplet) });
  }
  all.sort((a, b) => b.ppq - a.ppq);
  return all;
})();

/**
 * Binary note values only, longest first.  Tuplets are valid *exact* spellings,
 * but mixing them into greedy fallback can strand an unspellable remainder
 * (for example 11/16 after picking a quarter-note triplet).
 */
const BINARY_VALUES_DESC = VALUES_DESC.filter(({ value }) => value.tuplet === undefined);

/** Tuplet values only, used as a second exact-cover family when binary fails. */
const TUPLET_VALUES_DESC = VALUES_DESC.filter(({ value }) => value.tuplet !== undefined);

/** Length of the shortest binary value; binary onsets are multiples of it. */
const SMALLEST_BINARY_PPQ = BINARY_VALUES_DESC[BINARY_VALUES_DESC.length - 1].ppq;

/** Returns true when `value` is an integral multiple of `step` within tolerance. */
export function isMultipleOf(value: number, step: number): boolean {
  const ratio = value / step;
  return Math.abs(ratio - Math.round(ratio)) <= EPSILON;
}

/** Rounds `value` to the nearest point of a lattice anchored at zero. */
export function roundToLattice(value: number, lattice: number): number {
  return Math.round(value / lattice) * lattice;
}

/** Returns true when `ppq` is a duration the model can spell directly. */
export function isRepresentableDuration(ppq: number): boolean {
  return exactNoteValue(ppq) !== undefined;
}

/** Returns the single exact NoteValue for a duration, or undefined when none matches. */
function exactNoteValue(ppq: number): NoteValue | undefined {
  for (const { value, ppq: valuePpq } of VALUES_DESC) {
    if (Math.abs(ppq - valuePpq) <= EPSILON) {
      return value.tuplet
        ? { base: value.base, dots: value.dots, tuplet: { ...value.tuplet } }
        : { base: value.base, dots: value.dots };
    }
  }
  return undefined;
}

/** First beat-group boundary strictly after `ppq` on a grid starting at `originPpq`. */
function nextGroupBoundary(ppq: number, originPpq: number, groupLen: number): number {
  const rel = ppq - originPpq;
  return originPpq + (Math.floor(rel / groupLen + EPSILON) + 1) * groupLen;
}

/**
 * Greedy decomposition of `[start, end)` into representable values, largest
 * first, with an exact-match check (which is how dotted values appear) before
 * every greedy pick. All boundaries are 64th-note multiples by construction,
 * so the loop always terminates exactly.
 */
function greedyPiecesForValues(
  start: number,
  end: number,
  values: ReadonlyArray<{ value: NoteValue; ppq: number }>,
): DurationPiece[] | undefined {
  const out: DurationPiece[] = [];
  let cursor = start;
  while (end - cursor > EPSILON) {
    const remaining = end - cursor;
    const value = values.find((candidate) => candidate.ppq <= remaining + EPSILON)?.value;
    if (!value) {
      return undefined;
    }
    const durationPpq = noteValueToPpq(value);
    out.push({ startPpq: cursor, durationPpq, value });
    cursor += durationPpq;
  }
  return out;
}

function greedyPieces(start: number, end: number): DurationPiece[] {
  const exact = exactNoteValue(end - start);
  if (exact) return [{ startPpq: start, durationPpq: end - start, value: exact }];

  // Keep each fallback decomposition within a single rhythmic family.  Trying
  // binary values first preserves conventional spelling, while the tuplet
  // family covers valid triplet-grid durations such as 5/6.
  const binary = greedyPiecesForValues(start, end, BINARY_VALUES_DESC);
  if (binary) return binary;
  const tuplet = greedyPiecesForValues(start, end, TUPLET_VALUES_DESC);
  if (tuplet) return tuplet;

  throw new RangeError(`quantizeToScore: cannot notate duration ${end - start}`);
}

/**
 * Pipeline step 5 (notes): decompose one within-measure note segment into
 * tied representable values.
 *
 * Exactly-representable durations stay whole when they are no longer than one
 * beat group or begin on a group boundary. Longer off-beat durations are tied
 * at the last group boundary before their end, preserving the central beat of
 * the measure while avoiding an unnecessarily short first fragment.
 * Otherwise the segment splits at the next beat-group boundary and both
 * halves recurse, falling back to greedy largest-first packing inside a
 * single group.
 */
export function decomposeNote(
  start: number,
  end: number,
  originPpq: number,
  groupLen: number,
): DurationPiece[] {
  const exact = exactNoteValue(end - start);
  const crossesBoundary = nextGroupBoundary(start, originPpq, groupLen) < end - EPSILON;
  // A value starting off the binary lattice cannot stay whole across a beat boundary.
  const startsOffLattice = !isMultipleOf(start - originPpq, SMALLEST_BINARY_PPQ);
  if (exact && !(startsOffLattice && crossesBoundary)) {
    const groupPosition = (start - originPpq) / groupLen;
    const startsOnGroupBoundary = Math.abs(groupPosition - Math.round(groupPosition)) <= EPSILON;
    if (end - start <= groupLen + EPSILON || startsOnGroupBoundary) {
      return [{ startPpq: start, durationPpq: end - start, value: exact }];
    }
    const lastBoundaryIndex = Math.floor((end - originPpq) / groupLen - EPSILON);
    const boundary = originPpq + lastBoundaryIndex * groupLen;
    if (boundary > start + EPSILON) {
      return [
        ...greedyPieces(start, boundary),
        ...decomposeNote(boundary, end, originPpq, groupLen),
      ];
    }
  }
  const boundary = nextGroupBoundary(start, originPpq, groupLen);
  if (boundary < end - EPSILON) {
    return [
      ...decomposeNote(start, boundary, originPpq, groupLen),
      ...decomposeNote(boundary, end, originPpq, groupLen),
    ];
  }
  return greedyPieces(start, end);
}

/**
 * Pipeline step 6 (rests): decompose a gap into rest values.
 *
 * Unlike notes, rests split at beat-group boundaries even when the total gap
 * is exactly representable (no syncopated rests), except that a gap covering
 * the whole measure always becomes one measure rest. Its nominal note value
 * is ignored by the MusicXML serializer, which emits `<rest measure="yes"/>`.
 */
export function decomposeRest(
  start: number,
  end: number,
  measureStartPpq: number,
  measureLengthPpq: number,
  originPpq: number,
  groupLen: number,
): DurationPiece[] {
  const coversMeasure =
    start <= measureStartPpq + EPSILON && end >= measureStartPpq + measureLengthPpq - EPSILON;
  if (coversMeasure) {
    return [
      {
        startPpq: start,
        durationPpq: end - start,
        // A 5/4 or 5/8 measure has no ordinary single notehead value, but
        // measure rests deliberately omit `<type>` in MusicXML.
        value: exactNoteValue(end - start) ?? { base: 'whole', dots: 0 },
      },
    ];
  }
  const boundary = nextGroupBoundary(start, originPpq, groupLen);
  if (boundary < end - EPSILON) {
    return [
      ...decomposeRest(start, boundary, measureStartPpq, measureLengthPpq, originPpq, groupLen),
      ...decomposeRest(boundary, end, measureStartPpq, measureLengthPpq, originPpq, groupLen),
    ];
  }
  const exact = exactNoteValue(end - start);
  if (exact) {
    return [{ startPpq: start, durationPpq: end - start, value: exact }];
  }
  return greedyPieces(start, end);
}
