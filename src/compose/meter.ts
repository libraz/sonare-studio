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
import type { TimeSignatureSegment } from '@/project/types';

/** 4/4 fallback used when the project has no meter map. */
const DEFAULT_SEGMENT: TimeSignatureSegment = { startPpq: 0, numerator: 4, denominator: 4 };

/** Converts a project meter segment to a libcantus time signature. */
export function segmentToTimeSignature(segment: TimeSignatureSegment): TimeSignature {
  return { numerator: segment.numerator, denominator: segment.denominator };
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
  if (segments.length === 0) return DEFAULT_SEGMENT;
  const sorted = [...segments].sort((a, b) => a.startPpq - b.startPpq);
  let governing = sorted[0];
  for (const segment of sorted) {
    if (segment.startPpq <= ppq) governing = segment;
    else break;
  }
  return governing;
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
  try {
    return isStrongBeat(inSegmentBeat, segmentToTimeSignature(segment));
  } catch {
    return false;
  }
}
