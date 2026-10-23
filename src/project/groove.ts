/**
 * Groove templates: a repeating table of timing offsets measured against a
 * straight grid. A template is captured from a reference performance and then
 * applied to other notes, so one part can inherit another part's feel.
 *
 * Positions are timeline PPQ. Steps are counted from the start of the bar on
 * the project meter map, so a step index names the same metric position in
 * every bar and meter; a bar holding more steps than the template wraps it
 * modulo its period.
 */

import { measureRangeAt, snapPpqToBarGrid } from './time-signature';
import type { TimeSignatureSegment } from './types';

/** One repeating timing-offset template, measured from a straight grid. */
export interface GrooveTemplate {
  /** Grid resolution the offsets were measured against, in PPQ. */
  gridPpq: number;
  /** Offset from the straight grid for each step of one template period. */
  offsetsPpq: number[];
}

/** Minimum template period: sixteen steps, i.e. one 4/4 bar of a 1/16 grid. */
export const DEFAULT_GROOVE_STEPS = 16;

/** Tolerance when counting whole grid steps in a bar. */
const STEP_EPSILON = 1e-9;

/** True when a template can move notes at all. */
export function grooveTemplateIsUsable(groove: GrooveTemplate | null): groove is GrooveTemplate {
  return (
    groove !== null &&
    groove.gridPpq > 0 &&
    groove.offsetsPpq.length > 0 &&
    groove.offsetsPpq.some((offset) => Math.abs(offset) > 1e-9)
  );
}

/** Nearest straight grid line to a position and its step index within its bar. */
function barGridStep(
  timeSignatures: readonly TimeSignatureSegment[],
  positionPpq: number,
  gridPpq: number,
): { straightPpq: number; index: number; barSteps: number } {
  const bar = measureRangeAt(timeSignatures, positionPpq);
  const straightPpq = snapPpqToBarGrid(bar, positionPpq, gridPpq);
  const barSteps = Math.max(1, Math.ceil(bar.lengthPpq / gridPpq - STEP_EPSILON));
  // The barline closing the bar is the next bar's first step.
  const index =
    straightPpq >= bar.startPpq + bar.lengthPpq - STEP_EPSILON
      ? 0
      : Math.round((straightPpq - bar.startPpq) / gridPpq);
  return { straightPpq, index, barSteps };
}

/**
 * Extracts the average onset offset of every step of one template period.
 *
 * @param timeSignatures Project meter map the bars are read from.
 * @param positionsPpq Reference onsets on the timeline.
 * @param gridPpq Grid resolution in PPQ.
 * @param steps Minimum steps in one template period; it grows to the longest
 *   bar's step count so no two positions of a bar share a step.
 */
export function extractGrooveTemplate(
  timeSignatures: readonly TimeSignatureSegment[],
  positionsPpq: readonly number[],
  gridPpq: number,
  steps = DEFAULT_GROOVE_STEPS,
): GrooveTemplate {
  const measured: Array<{ index: number; offset: number }> = [];
  let count = Math.max(1, Math.floor(steps));
  if (gridPpq > 0) {
    for (const position of positionsPpq) {
      if (!Number.isFinite(position)) continue;
      const step = barGridStep(timeSignatures, position, gridPpq);
      count = Math.max(count, step.barSteps);
      measured.push({ index: step.index, offset: position - step.straightPpq });
    }
  }
  const sums = new Array<number>(count).fill(0);
  const hits = new Array<number>(count).fill(0);
  for (const { index, offset } of measured) {
    sums[index % count] += offset;
    hits[index % count] += 1;
  }
  return {
    gridPpq,
    offsetsPpq: sums.map((sum, index) => (hits[index] === 0 ? 0 : sum / hits[index])),
  };
}

/** Offset the template prescribes for the grid step nearest to a position. */
export function grooveOffsetPpq(
  groove: GrooveTemplate,
  timeSignatures: readonly TimeSignatureSegment[],
  positionPpq: number,
): number {
  const period = groove.offsetsPpq.length;
  if (!(groove.gridPpq > 0) || period === 0) return 0;
  const { index } = barGridStep(timeSignatures, positionPpq, groove.gridPpq);
  return groove.offsetsPpq[index % period] ?? 0;
}

/**
 * Moves one timeline position toward the groove.
 *
 * @param strength 0 = unchanged, 1 = the full captured offset.
 */
export function applyGrooveToPosition(
  groove: GrooveTemplate,
  timeSignatures: readonly TimeSignatureSegment[],
  positionPpq: number,
  strength = 1,
): number {
  const amount = Math.min(1, Math.max(0, strength));
  if (amount === 0) return positionPpq;
  const period = groove.offsetsPpq.length;
  if (!(groove.gridPpq > 0) || period === 0) return positionPpq;
  const { straightPpq, index } = barGridStep(timeSignatures, positionPpq, groove.gridPpq);
  const targetPpq = straightPpq + (groove.offsetsPpq[index % period] ?? 0);
  return positionPpq + (targetPpq - positionPpq) * amount;
}
