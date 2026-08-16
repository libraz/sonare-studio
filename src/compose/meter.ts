/**
 * Time-signature bridge between the project's {@link TimeSignatureSegment} map
 * and libcantus's single-signature {@link TimeSignature}.
 *
 * libcantus's positional functions accept the whole meter map, and answer
 * identically to resolving the governing segment and rebasing onto it — across
 * a meter change landing mid-bar as well. The segment is resolved here anyway
 * because {@link strongBeatAt} is asked once per note: a lookup over the
 * project's segments costs nothing, where handing over a map would mean
 * building one on every call.
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
 * Whether an absolute beat is metrically accented under its governing meter:
 * the downbeat, or the bar's secondary strong pulse. This is narrower than "is
 * a pulse at all" — 4/4 is accented on beats 1 and 3, not on 2 and 4 — and it
 * is the reading the safety evaluation wants, since what makes a dissonance
 * exposed is the accent rather than the pulse.
 *
 * The beat is measured from the segment's own start so bar lines follow meter
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
    // libcantus rejects a grouping that is empty, holds a non-positive-integer
    // group, or sums to neither the numerator nor the bar's pulse count.
    return false;
  }
}
