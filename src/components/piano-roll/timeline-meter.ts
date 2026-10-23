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
  snapClipPpqToMeterGrid,
} from '@/project/time-signature';
import type { TimeSignatureSegment } from '@/project/types';
import { type RulerTick, type RulerTickOptions, rulerTicks } from '@/ui/arrangement/ruler';

/** Tolerance that keeps a position on a grid line in that line's cell. */
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
  return snapClipPpqToMeterGrid(meter, originPpq, ppq, step);
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
  const bar = measureRangeAt(meter, position);
  if (step === 'bar') return bar.startPpq - originPpq;
  if (!(step > 0)) return position - originPpq;
  // Grid points restart at every bar, so the cell is counted from the bar start.
  const cells = Math.floor((position - bar.startPpq) / step + CELL_EPSILON_PPQ);
  return bar.startPpq + cells * step - originPpq;
}
