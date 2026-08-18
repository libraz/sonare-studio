/**
 * Time-signature map helpers shared across surfaces (score notation, recording,
 * count-in) so they all read the project's meter map the same way instead of
 * assuming 4/4.
 *
 * Bar arithmetic is libcantus's: {@link toMeterMap} is the one place a project
 * meter map crosses over, and the positional helpers answer from the library so
 * a bar line here and a bar line in a generated part cannot drift apart. What
 * stays local is what the library reads differently on purpose — bars are
 * counted from PPQ zero rather than from a pickup, and a bar cut short by a
 * meter change reports the length it actually occupies.
 */

import {
  barIndexAt,
  barStartBeat,
  beatsPerBarAt,
  type MeterMap,
  meterAt,
  toMeterData,
} from '@libraz/libcantus';
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

/** One contiguous range governed by a single time signature. */
export interface TimeSignatureRange extends TimeSignatureSegment {
  /** Exclusive end of this governing range. */
  endPpq: number;
}

/** A local rhythmic step in PPQ, or the full bar of the active meter. */
export type MeterGridStep = number | 'bar';

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

/**
 * Position libcantus's meter arithmetic is asked about: bars are counted from
 * PPQ zero on every surface here, so anything earlier reads as the first bar
 * rather than as a pickup, and a non-finite position — which the library
 * rejects outright — reads as the timeline origin instead of failing a paint.
 */
function meterQueryPpq(ppq: number): number {
  return Number.isFinite(ppq) ? Math.max(0, ppq) : 0;
}

/**
 * Drops an additive grouping libcantus will not read, keeping the plain meter.
 *
 * Which groupings are legal is the library's rule — the sum is counted in main
 * pulses or in denominator units, and a compound numerator accepts both — so it
 * is asked rather than restated here. A grouping it rejects would otherwise
 * fail every accent query made against the segment.
 */
function withReadableGrouping(segment: TimeSignatureSegment): TimeSignatureSegment {
  if (segment.grouping === undefined) return segment;
  try {
    toMeterData({
      numerator: segment.numerator,
      denominator: segment.denominator,
      grouping: segment.grouping,
    });
    return segment;
  } catch {
    return {
      startPpq: segment.startPpq,
      numerator: segment.numerator,
      denominator: segment.denominator,
    };
  }
}

/**
 * Validates, sorts and guarantees meter coverage from PPQ zero.
 *
 * The result is always a map libcantus accepts, so every caller can hand it
 * over without guarding against a rejection.
 */
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
    .map((segment) => withReadableGrouping({ ...segment }))
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
 * Converts a project meter map into the libcantus map every meter-aware call
 * reads.
 *
 * The single crossing point, and it normalizes on the way through: a raw map
 * whose first entry starts after zero would otherwise be read as a pickup in
 * that entry's signature rather than as 4/4 up to it.
 *
 * @param segments Time-signature segments in any order.
 * @returns The equivalent libcantus meter map, always valid input.
 */
export function toMeterMap(segments: readonly TimeSignatureSegment[]): MeterMap {
  return normalizeTimeSignatureMap(segments).map((segment) => ({
    startBeat: segment.startPpq,
    ts: {
      numerator: segment.numerator,
      denominator: segment.denominator,
      ...(segment.grouping !== undefined ? { grouping: segment.grouping } : {}),
    },
  }));
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
  const meter = meterAt(meterQueryPpq(ppq), toMeterMap(segments));
  return { numerator: meter.numerator, denominator: meter.denominator };
}

/** Resolves the complete meter-map segment governing an absolute PPQ position. */
export function timeSignatureSegmentAt(
  segments: readonly TimeSignatureSegment[],
  ppq: number,
): TimeSignatureSegment {
  const normalized = normalizeTimeSignatureMap(segments);
  let current = normalized[0];
  for (const segment of normalized) {
    if (segment.startPpq > ppq) break;
    current = segment;
  }
  return { ...current };
}

/**
 * Snaps a timeline position to the active meter segment's local grid. Numeric
 * steps are re-anchored at every meter change; `'bar'` follows the actual bar
 * length, including compound and asymmetric meters.
 */
export function snapPpqToMeterGrid(
  segments: readonly TimeSignatureSegment[],
  ppq: number,
  step: MeterGridStep,
): number {
  const position = Math.max(0, ppq);
  const meter = timeSignatureSegmentAt(segments, position);
  const localStep = step === 'bar' ? meterBarLengthPpq(meter) : step;
  if (!(localStep > 0) || !Number.isFinite(localStep)) return position;
  const relative = position - meter.startPpq;
  return Math.max(meter.startPpq, meter.startPpq + Math.round(relative / localStep) * localStep);
}

/**
 * Snaps to a locally anchored meter grid with optional straight-grid swing.
 * Swing delays odd grid divisions by at most one third of a division; triplet
 * grids and full-bar snapping deliberately ignore it.
 */
export function snapPpqToSwingMeterGrid(
  segments: readonly TimeSignatureSegment[],
  ppq: number,
  step: MeterGridStep,
  swingPercent = 0,
): number {
  if (step === 'bar') return snapPpqToMeterGrid(segments, ppq, step);
  const position = Math.max(0, ppq);
  if (!(step > 0) || !Number.isFinite(step)) return position;
  // 1/8T and 1/16T are already ternary; applying swing would distort them.
  if (Math.abs(step - 1 / 3) < PPQ_EPSILON || Math.abs(step - 1 / 6) < PPQ_EPSILON) {
    return snapPpqToMeterGrid(segments, position, step);
  }
  const amount = Math.min(100, Math.max(0, swingPercent)) / 100;
  if (amount <= 0) return snapPpqToMeterGrid(segments, position, step);
  const meter = timeSignatureSegmentAt(segments, position);
  const relative = position - meter.startPpq;
  const nearestIndex = Math.round(relative / step);
  let best = meter.startPpq;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = Math.max(0, nearestIndex - 2); index <= nearestIndex + 2; index += 1) {
    const candidate = meter.startPpq + index * step + (index % 2 === 0 ? 0 : (amount * step) / 3);
    const distance = Math.abs(position - candidate);
    if (
      distance < bestDistance - PPQ_EPSILON ||
      (Math.abs(distance - bestDistance) < PPQ_EPSILON && candidate < best)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Resolves contiguous, non-empty time-signature ranges intersecting a PPQ
 * window. Ranges are clipped to the requested window, so callers can split a
 * batch operation at every meter change without inventing their own map walk.
 */
export function timeSignatureRanges(
  segments: readonly TimeSignatureSegment[],
  startPpq: number,
  endPpq: number,
): TimeSignatureRange[] {
  if (!Number.isFinite(startPpq) || !Number.isFinite(endPpq) || endPpq <= startPpq) return [];
  const normalized = normalizeTimeSignatureMap(segments);
  const ranges: TimeSignatureRange[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const segment = normalized[index];
    const segmentEnd = normalized[index + 1]?.startPpq ?? Number.POSITIVE_INFINITY;
    const rangeStart = Math.max(startPpq, segment.startPpq);
    const rangeEnd = Math.min(endPpq, segmentEnd);
    if (rangeEnd <= rangeStart) continue;
    ranges.push({
      startPpq: rangeStart,
      endPpq: rangeEnd,
      numerator: segment.numerator,
      denominator: segment.denominator,
    });
  }
  return ranges;
}

/**
 * Returns the bar containing a position on an already-built meter map.
 *
 * Every libcantus entry point revalidates the map it is given, so the walkers
 * below build one map and reuse it rather than paying that per bar.
 */
function measureRangeOnMeterMap(meters: MeterMap, ppq: number): MeasureRange {
  const position = meterQueryPpq(ppq);
  const startPpq = barStartBeat(position, meters);
  const meter = meterAt(position, meters);
  // A meter change starts a new bar, so the bar it lands inside stops there
  // instead of running to its nominal length.
  const nextChangeStart =
    meters.find((change) => change.startBeat > startPpq)?.startBeat ?? Number.POSITIVE_INFINITY;
  return {
    startPpq,
    lengthPpq: Math.min(beatsPerBarAt(position, meters), nextChangeStart - startPpq),
    numerator: meter.numerator,
    denominator: meter.denominator,
    index: barIndexAt(position, meters),
  };
}

/** Returns the variable-meter bar containing an absolute PPQ position. */
export function measureRangeAt(
  segments: readonly TimeSignatureSegment[],
  ppq: number,
): MeasureRange {
  return measureRangeOnMeterMap(toMeterMap(segments), ppq);
}

/** Builds the shared score/compose grid, truncating a bar at a mid-bar meter change. */
export function measureGrid(
  segments: readonly TimeSignatureSegment[],
  startPpq: number,
  endPpq: number,
): MeasureRange[] {
  if (!Number.isFinite(startPpq) || !Number.isFinite(endPpq) || endPpq <= startPpq) return [];
  const meters = toMeterMap(segments);
  const ranges: MeasureRange[] = [];
  let cursor = startPpq;
  while (cursor < endPpq - PPQ_EPSILON) {
    const containing = measureRangeOnMeterMap(meters, cursor);
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
  const meters = toMeterMap(segments);
  let cursor = Math.max(0, punchInPpq);
  const count = Math.max(0, Math.floor(bars));
  for (let index = 0; index < count && cursor > 0; index += 1) {
    const previous = measureRangeOnMeterMap(meters, Math.max(0, cursor - 1e-6));
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
  const meters = toMeterMap(segments);
  let cursor = Math.max(0, startPpq);
  const count = Math.max(0, Math.floor(bars));
  for (let index = 0; index < count; index += 1) {
    const range = measureRangeOnMeterMap(meters, cursor);
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
