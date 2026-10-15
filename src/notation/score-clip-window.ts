import { measureRangeAt, timeSignatureAt } from '@/project/time-signature';
import type { TimeSignatureSegment } from '@/project/types';
import { type NotatedTimeSig, timeSigLengthPpq } from './model';

/** Inputs that determine the notated window for a clip-based score. */
export interface ScoreClipWindowInput {
  clipStartPpq: number;
  clipLengthPpq: number;
  pickupLengthPpq: number;
  timeSignatures: readonly TimeSignatureSegment[];
}

/** Meter and rounded length passed to the score transcription pipeline. */
export interface ScoreClipWindow {
  timeSig: NotatedTimeSig;
  measureLenPpq: number;
  clipLengthPpq: number;
}

/** Tolerance for a clip end sitting exactly on a barline. */
const BARLINE_EPSILON_PPQ = 1e-9;

/**
 * Resolves the clip-start meter and extends a score window to the next project
 * barline at or after the clip end, so the last engraved measure is complete.
 *
 * An initial pickup remains its original length; the content after it is
 * rounded to whole measures. A pickup never applies to a clip that starts
 * later in the project.
 */
export function scoreClipWindow(input: ScoreClipWindowInput): ScoreClipWindow {
  const meter = timeSignatureAt(input.timeSignatures, input.clipStartPpq);
  const timeSig = { beats: meter.numerator, beatUnit: meter.denominator };
  const measureLenPpq = timeSigLengthPpq(timeSig);
  const pickupLengthPpq = input.clipStartPpq === 0 ? input.pickupLengthPpq : 0;
  if (pickupLengthPpq > 0 && pickupLengthPpq < input.clipLengthPpq) {
    const clipLengthPpq =
      pickupLengthPpq +
      Math.max(1, Math.ceil((input.clipLengthPpq - pickupLengthPpq) / measureLenPpq)) *
        measureLenPpq;
    return { timeSig, measureLenPpq, clipLengthPpq };
  }
  const clipEndPpq = input.clipStartPpq + input.clipLengthPpq;
  const endBar = measureRangeAt(input.timeSignatures, clipEndPpq);
  const onBarline =
    clipEndPpq > input.clipStartPpq && clipEndPpq - endBar.startPpq <= BARLINE_EPSILON_PPQ;
  const windowEndPpq = onBarline ? clipEndPpq : endBar.startPpq + endBar.lengthPpq;
  const clipLengthPpq = windowEndPpq - input.clipStartPpq;

  return { timeSig, measureLenPpq, clipLengthPpq };
}
