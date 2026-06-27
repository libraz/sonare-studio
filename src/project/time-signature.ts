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
