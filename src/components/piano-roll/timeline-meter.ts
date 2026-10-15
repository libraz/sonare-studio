/**
 * Bar math for the piano roll's clip-source frame. Local PPQ 0 sits at
 * `originPpq` on the arrangement timeline, which need not be a bar line, so
 * bars, snap and ticks are resolved against the project meter map in timeline
 * space and shifted back. Bar lines and bar numbers then match the arrangement
 * ruler and Quantize.
 */

import {
  type MeasureRange,
  type MeterGridStep,
  measureRangeAt,
  snapPpqToMeterGrid,
} from '@/project/time-signature';
import type { TimeSignatureSegment } from '@/project/types';
import { type RulerTick, type RulerTickOptions, rulerTicks } from '@/ui/arrangement/ruler';

/** Tolerance when deciding that a rounded grid line lies past the position. */
const CELL_EPSILON_PPQ = 1e-9;

/** Bar containing a local position, with its start in the local frame. */
export function localMeasureRange(
  meter: readonly TimeSignatureSegment[],
  originPpq: number,
  ppq: number,
): MeasureRange {
  const range = measureRangeAt(meter, Math.max(0, ppq + originPpq));
  return { ...range, startPpq: range.startPpq - originPpq };
}

/** Snaps a local position to the timeline meter grid. */
export function snapLocalPpqToMeterGrid(
  meter: readonly TimeSignatureSegment[],
  originPpq: number,
  ppq: number,
  step: MeterGridStep,
): number {
  return snapPpqToMeterGrid(meter, ppq + originPpq, step) - originPpq;
}

/** Bar and beat ticks for a local range, numbered like the timeline ruler. */
export function localRulerTicks(
  meter: readonly TimeSignatureSegment[],
  originPpq: number,
  startPpq: number,
  endPpq: number,
  pxPerPpq: number,
  options?: RulerTickOptions,
): RulerTick[] {
  return rulerTicks(meter, startPpq + originPpq, endPpq + originPpq, pxPerPpq, options).map(
    (tick) => ({ ...tick, ppq: tick.ppq - originPpq }),
  );
}

/** Floors a local position to the start of the timeline meter-grid cell (or bar) containing it. */
export function floorLocalPpqToMeterGrid(
  meter: readonly TimeSignatureSegment[],
  originPpq: number,
  ppq: number,
  step: MeterGridStep,
): number {
  const position = Math.max(0, ppq + originPpq);
  if (step === 'bar') return measureRangeAt(meter, position).startPpq - originPpq;
  const snapped = snapPpqToMeterGrid(meter, position, step);
  return (snapped > position + CELL_EPSILON_PPQ ? snapped - step : snapped) - originPpq;
}
