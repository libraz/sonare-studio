/**
 * Repeating-pattern detection for the editor's chord track.
 *
 * The chord track carries no memory of which preset (if any) produced it, or
 * which repeat of a cycling pattern a chord belongs to — that information is
 * only implicit in the values themselves (generation cycles a preset's
 * degrees, but nothing is persisted once the result is written). This derives
 * grouping by finding maximal runs where a short sequence of chords (2-8
 * long) repeats verbatim, so the list editor can visualize and collapse
 * repeats without any data-model change.
 *
 * Matching is strict (root, quality, slash bass, and duration must all agree)
 * so a group never claims two chords that only look similar — a looser match
 * would misleadingly group e.g. a "C" with a "C/E" as the same pattern slot.
 *
 * Pure module; no cross-file state.
 */

import { chordExtensionSignature, type EditorChordSymbol } from '@/project/chords';

/** Smallest and largest repeating-unit length considered a "pattern". */
const MIN_PERIOD = 2;
const MAX_PERIOD = 8;

/** A maximal run of chords formed by a short sequence repeating in place. */
export interface PatternGroup {
  /** Index of the first chord in this group. */
  startIndex: number;
  /** Length of the repeating unit, in chords. */
  period: number;
  /** Number of full repeats of the unit (always >= 2). */
  repeatCount: number;
  /** Total chords covered, including any partial trailing repeat. */
  length: number;
  /** True when the group ends mid-cycle (the last repeat is shorter than `period`). */
  partialTrailingRepeat: boolean;
}

/** Chord identity for pattern matching: root, quality, slash bass, and duration all count. */
function sameSlot(a: EditorChordSymbol, b: EditorChordSymbol): boolean {
  return (
    a.rootPc === b.rootPc &&
    a.quality === b.quality &&
    chordExtensionSignature(a) === chordExtensionSignature(b) &&
    (a.bassPc ?? -1) === (b.bassPc ?? -1) &&
    a.endPpq - a.startPpq === b.endPpq - b.startPpq
  );
}

/** Whether the `length`-chord block at `a` matches the block at `b`. */
function blockEquals(
  chords: ReadonlyArray<EditorChordSymbol>,
  a: number,
  b: number,
  length: number,
): boolean {
  for (let k = 0; k < length; k++) {
    if (!sameSlot(chords[a + k], chords[b + k])) return false;
  }
  return true;
}

/** The smallest period in [MIN_PERIOD, MAX_PERIOD] that repeats at least twice from `start`, or 0. */
function findPeriod(chords: ReadonlyArray<EditorChordSymbol>, start: number): number {
  for (let period = MIN_PERIOD; period <= MAX_PERIOD; period++) {
    if (start + period * 2 <= chords.length && blockEquals(chords, start, start + period, period)) {
      return period;
    }
  }
  return 0;
}

/**
 * Finds maximal repeating-pattern groups across a chord track.
 *
 * Scans left to right; at each unclaimed position it looks for the smallest
 * repeating-unit length (2..8 chords) that repeats at least twice, extends
 * through every further full repeat plus one partial trailing repeat, then
 * resumes scanning after the group. Chords that don't start a qualifying
 * repeat are left out of the result entirely.
 */
export function detectProgressionGroups(chords: ReadonlyArray<EditorChordSymbol>): PatternGroup[] {
  const groups: PatternGroup[] = [];
  let i = 0;
  while (i < chords.length) {
    const period = findPeriod(chords, i);
    if (period === 0) {
      i += 1;
      continue;
    }
    let repeatCount = 1;
    while (
      i + (repeatCount + 1) * period <= chords.length &&
      blockEquals(chords, i, i + repeatCount * period, period)
    ) {
      repeatCount += 1;
    }
    const fullEnd = i + repeatCount * period;
    const remaining = chords.length - fullEnd;
    const partialLength =
      remaining > 0 && remaining < period && blockEquals(chords, i, fullEnd, remaining)
        ? remaining
        : 0;
    groups.push({
      startIndex: i,
      period,
      repeatCount,
      length: repeatCount * period + partialLength,
      partialTrailingRepeat: partialLength > 0,
    });
    i = fullEnd + partialLength;
  }
  return groups;
}
