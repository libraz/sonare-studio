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

/**
 * Snaps a position inside one bar to the step grid anchored at the bar's
 * start. The barline that ends the bar is a candidate too, so a step that does
 * not divide the bar never lands past it, off the next bar's grid.
 *
 * @param bar The bar (or notated measure) containing `ppq`.
 * @param ppq Position to snap, within the bar.
 * @param step Grid step in PPQ (> 0).
 * @returns The nearest grid point or the bar end; ties go to the later point.
 */
export function snapPpqToBarGrid(
  bar: Pick<MeasureRange, 'startPpq' | 'lengthPpq'>,
  ppq: number,
  step: number,
): number {
  const end = bar.startPpq + bar.lengthPpq;
  const relative = ppq - bar.startPpq;
  let grid = bar.startPpq + Math.round(relative / step) * step;
  if (grid >= end - PPQ_EPSILON) grid -= step;
  return Math.abs(end - ppq) <= Math.abs(ppq - grid) + PPQ_EPSILON ? end : grid;
}

/**
 * Snaps a timeline position to the meter grid: numeric steps are anchored at
 * the start of the bar containing the position, so they re-anchor at every
 * meter change and every barline stays a grid point; `'bar'` follows the
 * actual bar length, including compound and asymmetric meters.
 */
export function snapPpqToMeterGrid(
  segments: readonly TimeSignatureSegment[],
  ppq: number,
  step: MeterGridStep,
): number {
  const position = Math.max(0, ppq);
  const bar = measureRangeAt(segments, position);
  const localStep = step === 'bar' ? bar.lengthPpq : step;
  if (!(localStep > 0) || !Number.isFinite(localStep)) return position;
  return snapPpqToBarGrid(bar, position, localStep);
}

/**
 * Snaps to the bar-anchored meter grid with optional straight-grid swing.
 * Swing delays odd grid divisions of each bar by at most one third of a
 * division; triplet grids and full-bar snapping deliberately ignore it.
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
  const bar = measureRangeAt(segments, position);
  const end = bar.startPpq + bar.lengthPpq;
  const nearestIndex = Math.round((position - bar.startPpq) / step);
  let best = end;
  let bestDistance = Math.abs(end - position);
  for (let index = Math.max(0, nearestIndex - 2); index <= nearestIndex + 2; index += 1) {
    const candidate = bar.startPpq + index * step + (index % 2 === 0 ? 0 : (amount * step) / 3);
    if (candidate >= end - PPQ_EPSILON) break;
    const distance = Math.abs(position - candidate);
    if (distance < bestDistance - PPQ_EPSILON) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Snaps a clip-relative position on the project's meter grid. The position is
 * taken to the timeline through the clip start, snapped there and brought
 * back, so a clip, punch-in or source window that does not start on a grid
 * line never shifts the grid.
 *
 * @param segments Project time-signature map.
 * @param clipStartPpq Timeline position of clip-relative PPQ 0.
 * @param ppq Clip-relative position.
 * @param step Numeric grid step in PPQ, or `'bar'`.
 * @param swingPercent Straight-grid swing 0..100; triplet and bar grids ignore it.
 * @returns The snapped clip-relative position (negative when the nearest grid
 *   point precedes the clip start).
 */
export function snapClipPpqToMeterGrid(
  segments: readonly TimeSignatureSegment[],
  clipStartPpq: number,
  ppq: number,
  step: MeterGridStep,
  swingPercent = 0,
): number {
  return snapPpqToSwingMeterGrid(segments, clipStartPpq + ppq, step, swingPercent) - clipStartPpq;
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

/**
 * Lists the numeric meter-grid points in `[startPpq, endPpq)`: every bar's
 * start plus whole steps from it, so each point is a position
 * {@link snapPpqToMeterGrid} returns.
 */
export function meterGridLines(
  segments: readonly TimeSignatureSegment[],
  startPpq: number,
  endPpq: number,
  step: number,
): number[] {
  if (!(step > 0) || !Number.isFinite(startPpq) || !Number.isFinite(endPpq)) return [];
  const meters = toMeterMap(segments);
  const lines: number[] = [];
  let bar = measureRangeOnMeterMap(meters, startPpq);
  while (bar.startPpq < endPpq) {
    const barEnd = bar.startPpq + bar.lengthPpq;
    const first = Math.max(0, Math.ceil((startPpq - bar.startPpq) / step - PPQ_EPSILON));
    for (let index = first; ; index += 1) {
      const ppq = bar.startPpq + index * step;
      if (ppq >= barEnd - PPQ_EPSILON || ppq >= endPpq) break;
      lines.push(ppq);
    }
    bar = measureRangeOnMeterMap(meters, barEnd);
  }
  return lines;
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

/**
 * Measure grid of a notated clip window: project barlines from the clip start,
 * or, when the clip opens at PPQ 0 with a pickup, the short pickup measure
 * followed by full bars of the governing meter (cut at meter changes).
 */
export function clipMeasureGrid(
  segments: readonly TimeSignatureSegment[],
  startPpq: number,
  endPpq: number,
  pickupLengthPpq: number,
): MeasureRange[] {
  if (!(pickupLengthPpq > 0) || Math.abs(startPpq) > PPQ_EPSILON) {
    return measureGrid(segments, startPpq, endPpq);
  }
  const pickupEnd = Math.min(endPpq, startPpq + pickupLengthPpq);
  const first = timeSignatureAt(segments, startPpq);
  const ranges: MeasureRange[] = [
    {
      startPpq,
      lengthPpq: pickupEnd - startPpq,
      numerator: first.numerator,
      denominator: first.denominator,
      index: 0,
    },
  ];
  let cursor = pickupEnd;
  while (cursor < endPpq - PPQ_EPSILON) {
    const meter = timeSignatureAt(segments, cursor);
    const nextChange = normalizeTimeSignatureMap(segments).find(
      (segment) => segment.startPpq > cursor + PPQ_EPSILON,
    )?.startPpq;
    const end = Math.min(
      endPpq,
      cursor + meterBarLengthPpq(meter),
      nextChange ?? Number.POSITIVE_INFINITY,
    );
    ranges.push({
      startPpq: cursor,
      lengthPpq: end - cursor,
      numerator: meter.numerator,
      denominator: meter.denominator,
      index: ranges.length,
    });
    cursor = end;
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

/** PPQ of the start of a 1-based bar number on the project meter map. */
export function barStartPpq(segments: readonly TimeSignatureSegment[], bar: number): number {
  return advanceBarsPpq(segments, 0, Math.floor(bar) - 1);
}

/** 1-based number of the bar containing an absolute PPQ position. */
export function barNumberAt(segments: readonly TimeSignatureSegment[], ppq: number): number {
  return measureRangeAt(segments, Math.max(0, ppq)).index + 1;
}

/**
 * Number of bars a PPQ range spans, each portion measured against the bar
 * length of the meter governing it (fractional for a partial bar).
 */
export function barsBetweenPpq(
  segments: readonly TimeSignatureSegment[],
  startPpq: number,
  endPpq: number,
): number {
  return measureGrid(segments, startPpq, endPpq).reduce(
    (bars, measure) => bars + measure.lengthPpq / meterBarLengthPpq(measure),
    0,
  );
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

/** Bars a keyboard bar-step moves by: one, or four with the coarse modifier. */
const COARSE_BAR_STEPS = 4;

/**
 * Distance from `ppq` to the bar boundary one bar (four when `coarse`) away.
 * Stepping left from inside a bar lands on that bar's own start first.
 */
export function adjacentBarDelta(
  measureAt: (ppq: number) => { startPpq: number; lengthPpq: number },
  ppq: number,
  direction: 'left' | 'right',
  coarse: boolean,
): number {
  let cursor = Math.max(0, ppq);
  const steps = coarse ? COARSE_BAR_STEPS : 1;
  for (let index = 0; index < steps; index += 1) {
    const current = measureAt(cursor);
    if (direction === 'right') {
      cursor = current.startPpq + current.lengthPpq;
      continue;
    }
    cursor =
      cursor > current.startPpq + 1e-9
        ? current.startPpq
        : measureAt(Math.max(0, cursor - 1e-6)).startPpq;
  }
  return cursor - ppq;
}
