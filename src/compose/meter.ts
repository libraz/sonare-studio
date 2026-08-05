/**
 * Time-signature bridge between the project's {@link TimeSignatureSegment} map
 * and libcantus's single-signature {@link TimeSignature}.
 *
 * libcantus meter functions take one `TimeSignature`, so a project with meter
 * changes must resolve the governing segment for the PPQ position of interest
 * and pass that; callers spanning a meter change split their work per segment.
 *
 * Pure module.
 */

import { isStrongBeat, type TimeSignature } from '@libraz/libcantus';
import { timeSignatureSegmentAt } from '@/project/time-signature';
import type { TimeSignatureSegment } from '@/project/types';

/** Converts a project meter segment to a libcantus time signature. */
export function segmentToTimeSignature(segment: TimeSignatureSegment): TimeSignature {
  return {
    numerator: segment.numerator,
    denominator: segment.denominator,
    ...(segment.grouping !== undefined ? { grouping: segment.grouping } : {}),
  };
}

/** Validated additive group lengths, or null when the segment is conventional. */
function additiveGrouping(segment: TimeSignatureSegment): number[] | null {
  const grouping = segment.grouping;
  if (
    grouping === undefined ||
    grouping.length === 0 ||
    !grouping.every((group) => Number.isInteger(group) && group > 0) ||
    grouping.reduce((sum, group) => sum + group, 0) !== segment.numerator
  ) {
    return null;
  }
  return grouping;
}

/**
 * Returns the meter segment governing an absolute PPQ position: the last
 * segment starting at or before `ppq`, or the earliest segment when `ppq`
 * precedes them all, or 4/4 when the map is empty.
 */
export function segmentAtPpq(
  segments: ReadonlyArray<TimeSignatureSegment>,
  ppq: number,
): TimeSignatureSegment {
  return timeSignatureSegmentAt(segments, ppq);
}

/** Resolves the libcantus time signature governing an absolute PPQ position. */
export function timeSignatureAtPpq(
  segments: ReadonlyArray<TimeSignatureSegment>,
  ppq: number,
): TimeSignature {
  return segmentToTimeSignature(segmentAtPpq(segments, ppq));
}

/**
 * Whether an absolute beat is metrically strong under its governing meter. The
 * beat is measured from the segment's own start so bar lines follow meter
 * changes rather than assuming bars anchored at beat 0. A failed libcantus
 * evaluation degrades to `false` (not strong) rather than throwing.
 */
export function strongBeatAt(
  segments: ReadonlyArray<TimeSignatureSegment>,
  absBeat: number,
): boolean {
  const segment = segmentAtPpq(segments, absBeat);
  const inSegmentBeat = Math.max(0, absBeat - segment.startPpq);
  const grouping = additiveGrouping(segment);
  if (grouping !== null) {
    const unitPpq = 4 / segment.denominator;
    const barLengthPpq = segment.numerator * unitPpq;
    const inBarPpq = inSegmentBeat % barLengthPpq;
    let boundaryPpq = 0;
    for (const group of grouping) {
      if (Math.abs(inBarPpq - boundaryPpq) < 1e-6) return true;
      boundaryPpq += group * unitPpq;
    }
    return false;
  }
  try {
    return isStrongBeat(inSegmentBeat, segmentToTimeSignature(segment));
  } catch {
    return false;
  }
}
