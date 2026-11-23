import {
  clipMeasureGrid,
  meterBarLengthPpq,
  snapPpqToBarGrid,
  timeSignatureAt,
} from '@/project/time-signature';
import type { TimeSignatureSegment } from '@/project/types';
import { type NotatedTimeSig, timeSigLengthPpq } from './model';
import { PPQ_EPSILON } from './musicxml-shared';
import { EPSILON } from './voice-unit';

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
 * The opening pickup a score window starting at `startPpq` carries, before any
 * rounding onto the display grid: only a window opening at PPQ 0 has one. The
 * window, the click resolver and the quantizer all read it from here.
 */
export function openingPickupPpq(startPpq: number, pickupLengthPpq: number | undefined): number {
  return startPpq === 0 && Number.isFinite(pickupLengthPpq) && (pickupLengthPpq ?? 0) > 0
    ? (pickupLengthPpq ?? 0)
    : 0;
}

/**
 * Resolves the clip-start meter and extends a score window to the next
 * barline at or after the clip end, so the last engraved measure is complete.
 *
 * Barlines are the clip's measure grid: project barlines, or after an initial
 * pickup its full bars cut at meter changes. A pickup never applies to a clip
 * that starts later in the project.
 */
export function scoreClipWindow(input: ScoreClipWindowInput): ScoreClipWindow {
  const meter = timeSignatureAt(input.timeSignatures, input.clipStartPpq);
  const timeSig = { beats: meter.numerator, beatUnit: meter.denominator };
  const measureLenPpq = timeSigLengthPpq(timeSig);
  const pickupLengthPpq = openingPickupPpq(input.clipStartPpq, input.pickupLengthPpq);
  const clipEndPpq = input.clipStartPpq + input.clipLengthPpq;
  // The bar holding the clip end is no longer than a bar of the meter there.
  const searchEndPpq =
    clipEndPpq + meterBarLengthPpq(timeSignatureAt(input.timeSignatures, clipEndPpq));
  const endBar = clipMeasureGrid(
    input.timeSignatures,
    input.clipStartPpq,
    searchEndPpq,
    pickupLengthPpq,
  ).find((measure) => measure.startPpq + measure.lengthPpq >= clipEndPpq - PPQ_EPSILON);
  const windowEndPpq = endBar ? endBar.startPpq + endBar.lengthPpq : clipEndPpq;
  return { timeSig, measureLenPpq, clipLengthPpq: windowEndPpq - input.clipStartPpq };
}

/**
 * Builds the onset the display quantizer engraves for a note in a score
 * window: snapped to the display grid from the start of its measure (an
 * opening pickup is first rounded onto the grid) and kept inside the window,
 * a start that rounds onto the window end falling back to the last grid onset.
 * Click-to-note matching reads it so a clicked onset finds its source notes.
 *
 * @param input The same window inputs the score is engraved from.
 * @param gridPpq Display-quantize grid step in PPQ (> 0).
 * @returns Onset for a note, or null when the note does not overlap the window.
 */
export function scoreOnsetResolver(
  input: ScoreClipWindowInput,
  gridPpq: number,
): (note: { startPpq: number; durationPpq: number }) => number | null {
  const startPpq = input.clipStartPpq;
  const windowLengthPpq = scoreClipWindow(input).clipLengthPpq;
  const requestedPickup = openingPickupPpq(startPpq, input.pickupLengthPpq);
  const pickupSteps = Math.round(requestedPickup / gridPpq);
  const pickupLengthPpq = pickupSteps * gridPpq;
  // Moving the pickup barline onto the grid moves every later barline with it.
  const endPpq = startPpq + windowLengthPpq + (pickupLengthPpq - requestedPickup);
  const measures = clipMeasureGrid(input.timeSignatures, startPpq, endPpq, pickupLengthPpq);
  const last = measures[measures.length - 1];
  const lastOnsetPpq = last
    ? last.startPpq + (Math.max(1, Math.ceil(last.lengthPpq / gridPpq - EPSILON)) - 1) * gridPpq
    : startPpq;
  return (note) => {
    if (note.startPpq + note.durationPpq <= startPpq + EPSILON) return null;
    if (note.startPpq >= endPpq - EPSILON) return null;
    let measure = measures[0];
    for (const candidate of measures) {
      if (candidate.startPpq > note.startPpq + EPSILON) break;
      measure = candidate;
    }
    if (!measure) return startPpq;
    const onset = Math.max(startPpq, snapPpqToBarGrid(measure, note.startPpq, gridPpq));
    return onset >= endPpq - EPSILON ? lastOnsetPpq : onset;
  };
}
