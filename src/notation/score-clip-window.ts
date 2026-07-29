import { timeSignatureAt } from '@/project/time-signature';
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

/**
 * Resolves the clip-start meter and extends a score window to complete bars.
 *
 * An initial pickup remains its original length; the content after it is
 * rounded to whole measures. A pickup never applies to a clip that starts
 * later in the project.
 */
export function scoreClipWindow(input: ScoreClipWindowInput): ScoreClipWindow {
  const meter = timeSignatureAt(input.timeSignatures, input.clipStartPpq);
  const timeSig = { beats: meter.numerator, beatUnit: meter.denominator };
  const measureLenPpq = timeSigLengthPpq(timeSig);
  const actualMeasures = Math.max(1, Math.ceil(input.clipLengthPpq / measureLenPpq));
  const pickupLengthPpq = input.clipStartPpq === 0 ? input.pickupLengthPpq : 0;
  const clipLengthPpq =
    pickupLengthPpq <= 0 || pickupLengthPpq >= input.clipLengthPpq
      ? actualMeasures * measureLenPpq
      : pickupLengthPpq +
        Math.max(1, Math.ceil((input.clipLengthPpq - pickupLengthPpq) / measureLenPpq)) *
          measureLenPpq;

  return { timeSig, measureLenPpq, clipLengthPpq };
}
