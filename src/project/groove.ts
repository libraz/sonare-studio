/**
 * Groove templates: a repeating table of timing offsets measured against a
 * straight grid. A template is captured from a reference performance and then
 * applied to other notes, so one part can inherit another part's feel.
 *
 * Positions are plain PPQ values relative to the grid origin the caller
 * chooses (the command layer uses the position within the active meter
 * segment, so a template stays aligned across meter changes).
 */

/** One repeating timing-offset template, measured from a straight grid. */
export interface GrooveTemplate {
  /** Grid resolution the offsets were measured against, in PPQ. */
  gridPpq: number;
  /** Offset from the straight grid for each step of one template period. */
  offsetsPpq: number[];
}

/** Default template period: sixteen steps, i.e. one bar of a 1/16 grid. */
export const DEFAULT_GROOVE_STEPS = 16;

/** True when a template can move notes at all. */
export function grooveTemplateIsUsable(groove: GrooveTemplate | null): groove is GrooveTemplate {
  return (
    groove !== null &&
    groove.gridPpq > 0 &&
    groove.offsetsPpq.length > 0 &&
    groove.offsetsPpq.some((offset) => Math.abs(offset) > 1e-9)
  );
}

/**
 * Extracts the average onset offset of every step of one template period.
 *
 * @param positionsPpq Reference onsets, relative to the grid origin.
 * @param gridPpq Grid resolution in PPQ.
 * @param steps Number of steps in one template period.
 */
export function extractGrooveTemplate(
  positionsPpq: readonly number[],
  gridPpq: number,
  steps = DEFAULT_GROOVE_STEPS,
): GrooveTemplate {
  const count = Math.max(1, Math.floor(steps));
  const sums = new Array<number>(count).fill(0);
  const hits = new Array<number>(count).fill(0);
  if (gridPpq > 0) {
    for (const position of positionsPpq) {
      if (!Number.isFinite(position)) continue;
      const nearest = Math.round(position / gridPpq);
      const index = ((nearest % count) + count) % count;
      sums[index] += position - nearest * gridPpq;
      hits[index] += 1;
    }
  }
  return {
    gridPpq,
    offsetsPpq: sums.map((sum, index) => (hits[index] === 0 ? 0 : sum / hits[index])),
  };
}

/** Offset the template prescribes for the grid step nearest to a position. */
export function grooveOffsetPpq(groove: GrooveTemplate, positionPpq: number): number {
  const period = groove.offsetsPpq.length;
  if (!(groove.gridPpq > 0) || period === 0) return 0;
  const step = Math.round(positionPpq / groove.gridPpq);
  return groove.offsetsPpq[((step % period) + period) % period] ?? 0;
}

/**
 * Moves one position toward the groove.
 *
 * @param strength 0 = unchanged, 1 = the full captured offset.
 */
export function applyGrooveToPosition(
  groove: GrooveTemplate,
  positionPpq: number,
  strength = 1,
): number {
  const amount = Math.min(1, Math.max(0, strength));
  if (amount === 0) return positionPpq;
  return positionPpq + grooveOffsetPpq(groove, positionPpq) * amount;
}
