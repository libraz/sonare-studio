/**
 * Time-signature map helpers shared across surfaces (score notation, recording,
 * count-in) so they all read the project's meter map the same way instead of
 * assuming 4/4.
 */

import type { TimeSignatureSegment } from './types';

/** Default meter assumed when a project models no time-signature map. */
export const DEFAULT_TIME_SIGNATURE: { numerator: number; denominator: number } = {
  numerator: 4,
  denominator: 4,
};

const PPQ_EPSILON = 1e-9;

export interface MeasureRange {
  startPpq: number;
  lengthPpq: number;
  numerator: number;
  denominator: number;
  index: number;
}

/** Length of one bar for a meter segment in quarter-note PPQ. */
export function meterBarLengthPpq(
  meter: Pick<TimeSignatureSegment, 'numerator' | 'denominator'>,
): number {
  return (meter.numerator * 4) / meter.denominator;
}

/** Length of one denominator beat for a meter segment in quarter-note PPQ. */
export function meterBeatLengthPpq(meter: Pick<TimeSignatureSegment, 'denominator'>): number {
  return 4 / meter.denominator;
}

/** Validates, sorts and guarantees meter coverage from PPQ zero. */
export function normalizeTimeSignatureMap(
  segments: readonly TimeSignatureSegment[],
): TimeSignatureSegment[] {
  const valid = segments
    .filter(
      (segment) =>
        Number.isFinite(segment.startPpq) &&
        segment.startPpq >= 0 &&
        Number.isInteger(segment.numerator) &&
        segment.numerator >= 1 &&
        Number.isInteger(segment.denominator) &&
        segment.denominator >= 1,
    )
    .map((segment) => ({ ...segment }))
    .sort((a, b) => a.startPpq - b.startPpq)
    .filter(
      (segment, index, sorted) =>
        index === sorted.length - 1 || sorted[index + 1].startPpq !== segment.startPpq,
    );
  if (valid.length === 0 || valid[0].startPpq > 0) {
    valid.unshift({ startPpq: 0, ...DEFAULT_TIME_SIGNATURE });
  }
  return valid;
}

/**
 * Resolves the time signature in effect at a PPQ position from a
 * sorted-by-start segment list.
 *
 * @param segments Time-signature segments, ascending by startPpq.
 * @param ppq Query position in PPQ.
 * @returns The active meter, or {@link DEFAULT_TIME_SIGNATURE} when the list is
 *   empty or the position precedes the first segment.
 */
export function timeSignatureAt(
  segments: readonly TimeSignatureSegment[],
  ppq: number,
): { numerator: number; denominator: number } {
  let current = { ...DEFAULT_TIME_SIGNATURE };
  for (const segment of segments) {
    if (segment.startPpq <= ppq) {
      current = { numerator: segment.numerator, denominator: segment.denominator };
    } else break;
  }
  return current;
}

/** Returns the variable-meter bar containing an absolute PPQ position. */
export function measureRangeAt(
  segments: readonly TimeSignatureSegment[],
  ppq: number,
): MeasureRange {
  const normalized = normalizeTimeSignatureMap(segments);
  const position = Math.max(0, ppq);
  let segmentIndex = 0;
  let measuresBefore = 0;
  while (
    segmentIndex + 1 < normalized.length &&
    normalized[segmentIndex + 1].startPpq <= position
  ) {
    const current = normalized[segmentIndex];
    const next = normalized[segmentIndex + 1];
    measuresBefore += Math.max(
      1,
      Math.ceil((next.startPpq - current.startPpq) / meterBarLengthPpq(current) - PPQ_EPSILON),
    );
    segmentIndex += 1;
  }
  const segment = normalized[segmentIndex];
  const segmentEnd = normalized[segmentIndex + 1]?.startPpq ?? Number.POSITIVE_INFINITY;
  const barLength = meterBarLengthPpq(segment);
  const localIndex = Math.floor((position - segment.startPpq) / barLength + PPQ_EPSILON);
  const startPpq = segment.startPpq + localIndex * barLength;
  return {
    startPpq,
    lengthPpq: Math.min(barLength, segmentEnd - startPpq),
    numerator: segment.numerator,
    denominator: segment.denominator,
    index: measuresBefore + localIndex,
  };
}

/** Builds the shared score/compose grid, truncating a bar at a mid-bar meter change. */
export function measureGrid(
  segments: readonly TimeSignatureSegment[],
  startPpq: number,
  endPpq: number,
): MeasureRange[] {
  if (!Number.isFinite(startPpq) || !Number.isFinite(endPpq) || endPpq <= startPpq) return [];
  const ranges: MeasureRange[] = [];
  let cursor = startPpq;
  while (cursor < endPpq - PPQ_EPSILON) {
    const containing = measureRangeAt(segments, cursor);
    const naturalEnd = containing.startPpq + containing.lengthPpq;
    const rangeEnd = Math.min(endPpq, Math.max(cursor + PPQ_EPSILON, naturalEnd));
    ranges.push({
      ...containing,
      startPpq: cursor,
      lengthPpq: rangeEnd - cursor,
      index: ranges.length,
    });
    cursor = rangeEnd;
  }
  return ranges;
}

/** Walks backward over the actual meter grid for a recording count-in. */
export function countInStartPpq(
  segments: readonly TimeSignatureSegment[],
  punchInPpq: number,
  bars: number,
): number {
  let cursor = Math.max(0, punchInPpq);
  const count = Math.max(0, Math.floor(bars));
  for (let index = 0; index < count && cursor > 0; index += 1) {
    const previous = measureRangeAt(segments, Math.max(0, cursor - 1e-6));
    cursor = Math.max(0, previous.startPpq);
  }
  return cursor;
}

/** Advances a requested number of bars across meter changes. */
export function advanceBarsPpq(
  segments: readonly TimeSignatureSegment[],
  startPpq: number,
  bars: number,
): number {
  let cursor = Math.max(0, startPpq);
  const count = Math.max(0, Math.floor(bars));
  for (let index = 0; index < count; index += 1) {
    const range = measureRangeAt(segments, cursor);
    const rangeEnd = range.startPpq + range.lengthPpq;
    cursor = rangeEnd > cursor + PPQ_EPSILON ? rangeEnd : cursor + range.lengthPpq;
  }
  return cursor;
}

/** True when a requested bar range is entirely representable by 4/4-only generators. */
export function isFourFourBarRange(
  segments: readonly TimeSignatureSegment[],
  startPpq: number,
  bars: number,
): boolean {
  const endPpq = startPpq + Math.max(0, Math.floor(bars)) * 4;
  return measureGrid(segments, startPpq, endPpq).every(
    (measure) => measure.numerator === 4 && measure.denominator === 4,
  );
}
