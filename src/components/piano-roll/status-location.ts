/**
 * Lightweight bar/beat lookup for the piano-roll pointer status. Unlike ruler
 * tick generation, this resolves only the hovered measure and stays constant
 * work for every pointer move regardless of project length.
 */

import { measureRangeAt, meterBeatLengthPpq } from '@/project/time-signature';
import type { TimeSignatureSegment } from '@/project/types';

/** One-based bar and beat position shown in the piano-roll status line. */
export interface PianoRollStatusLocation {
  bar: number;
  beat: number;
}

/** Returns the variable-meter bar and beat containing a local piano-roll PPQ. */
export function pianoRollStatusLocation(
  timeSignatures: readonly TimeSignatureSegment[],
  ppq: number,
): PianoRollStatusLocation {
  const position = Math.max(0, ppq);
  const measure = measureRangeAt(timeSignatures, position);
  return {
    bar: measure.index + 1,
    beat: Math.floor((position - measure.startPpq) / meterBeatLengthPpq(measure)) + 1,
  };
}
