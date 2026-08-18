/**
 * Meter queries the composition surfaces make against the project's
 * {@link TimeSignatureSegment} map.
 *
 * libcantus reads a whole meter map, so the map goes over as it is and the
 * library decides where bars and accents fall — across a meter change landing
 * mid-bar as well. What is left here is the project's reading of a position the
 * map does not describe: everything before the timeline belongs to the opening
 * bar rather than to a pickup, and a position that is not a number is no
 * position at all.
 *
 * Pure module.
 */

import { isStrongBeat, meterAt, type TimeSignature } from '@libraz/libcantus';
import { toMeterMap } from '@/project/time-signature';
import type { TimeSignatureSegment } from '@/project/types';

/** Resolves the libcantus time signature governing an absolute PPQ position. */
export function timeSignatureAtPpq(
  segments: ReadonlyArray<TimeSignatureSegment>,
  ppq: number,
): TimeSignature {
  return meterAt(Number.isFinite(ppq) ? Math.max(0, ppq) : 0, toMeterMap(segments));
}

/**
 * Whether an absolute beat is metrically accented under its governing meter:
 * the downbeat, or the bar's secondary strong pulse. This is narrower than "is
 * a pulse at all" — 4/4 is accented on beats 1 and 3, not on 2 and 4 — and it
 * is the reading the safety evaluation wants, since what makes a dissonance
 * exposed is the accent rather than the pulse.
 *
 * The beat is absolute: bar lines follow the map's own meter changes, so a
 * change starts a bar and accents the beat it lands on. A position before the
 * timeline reads as the opening downbeat, and one that is not finite — which
 * names no beat for the library to weigh — is not accented.
 */
export function strongBeatAt(
  segments: ReadonlyArray<TimeSignatureSegment>,
  absBeat: number,
): boolean {
  if (!Number.isFinite(absBeat)) return false;
  return isStrongBeat(Math.max(0, absBeat), toMeterMap(segments));
}
