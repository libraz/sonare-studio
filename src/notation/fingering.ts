import { staffForMeanPitch } from '@/notation/grand-staff';
import type { NotatedClef } from '@/notation/model';
import { type AssignedVoiceUnits, meanPitch, type VoiceUnit } from '@/notation/voice-unit';

/** Largest interval (a whole step) that keeps a note inside a stepwise run. */
const FINGERING_RUN_STEP_SEMITONES = 2;

/** Finger a scale run turns to when the thumb passes under (or crosses over). */
const FINGERING_TURN_FINGER = 3;

/**
 * Right-hand chord fingering by note count, index-aligned with ascending
 * pitches (thumb on the lowest note). The left hand mirrors this by reversal
 * (thumb on the highest note).
 */
const RIGHT_HAND_CHORD_FINGERS: Readonly<Record<number, number[]>> = {
  1: [1],
  2: [1, 5],
  3: [1, 3, 5],
  4: [1, 2, 3, 5],
  5: [1, 2, 3, 4, 5],
};

/** Which hand plays a staff (1 = right, 2 = left); single staves use the clef. */
type Hand = 'right' | 'left';

function handForStaff(staff: 1 | 2 | undefined, clef: NotatedClef | undefined): Hand {
  if (staff === 1) return 'right';
  if (staff === 2) return 'left';
  return clef === 'bass' ? 'left' : 'right';
}

/**
 * Fingering for a chord of `count` notes, index-aligned with ascending
 * pitches. The right hand spreads thumb (lowest) to pinky (highest); the left
 * hand mirrors it (thumb on the highest note). Chords wider than five notes
 * spread the five fingers evenly across the stack.
 */
function chordFingers(count: number, hand: Hand): number[] {
  const table = RIGHT_HAND_CHORD_FINGERS[count];
  const fingers =
    table !== undefined
      ? [...table]
      : Array.from({ length: count }, (_, i) => 1 + Math.round((i * 4) / (count - 1)));
  return hand === 'right' ? fingers : fingers.reverse();
}

/**
 * Fingering for a stepwise scale run of `count` notes, index-aligned with
 * ascending pitches. The pinky-side note (highest for the right hand, lowest
 * for the left) takes finger 5 and the count walks toward the thumb, turning
 * back to {@link FINGERING_TURN_FINGER} when the thumb is reached, which
 * reproduces the familiar 1-2-3-1-2-3-4-5 shape for an octave scale.
 */
function runFingers(count: number, hand: Hand): number[] {
  const fingers = new Array<number>(count);
  let finger = 5;
  for (let k = 0; k < count; k++) {
    const index = hand === 'right' ? count - 1 - k : k;
    fingers[index] = finger;
    finger -= 1;
    if (finger < 1) finger = FINGERING_TURN_FINGER;
  }
  return fingers;
}

/** Finger for an isolated note or a leap: one step from the previous finger. */
function isolatedFinger(
  pitch: number,
  prevPitch: number | undefined,
  prevFinger: number | undefined,
  hand: Hand,
): number {
  if (prevPitch === undefined || prevFinger === undefined) return 1;
  const rising = pitch > prevPitch;
  // A move toward the pinky raises the finger number; the left hand mirrors it.
  const towardPinky = hand === 'right' ? rising : !rising;
  return Math.min(5, Math.max(1, prevFinger + (towardPinky ? 1 : -1)));
}

/**
 * Greedily assigns fingering to one hand's monophonic-or-chordal unit stream
 * (onset-ordered, non-overlapping). Chords spread thumb..pinky; maximal
 * stepwise monotonic single-note runs use {@link runFingers}; isolated notes
 * and leaps step one finger from the previous note toward the leap direction.
 */
function assignHandFingering(units: VoiceUnit[], hand: Hand): void {
  let prevPitch: number | undefined;
  let prevFinger: number | undefined;
  let i = 0;
  while (i < units.length) {
    const unit = units[i];
    if (unit.pitches.length > 1) {
      unit.fingering = chordFingers(unit.pitches.length, hand);
      // The thumb anchors the chord on both hands.
      prevPitch = hand === 'right' ? unit.pitches[0] : unit.pitches[unit.pitches.length - 1];
      prevFinger = 1;
      i += 1;
      continue;
    }
    // Extend a stepwise, monotonic single-note run starting at i.
    let j = i + 1;
    let direction = 0;
    while (j < units.length && units[j].pitches.length === 1) {
      const interval = units[j].pitches[0] - units[j - 1].pitches[0];
      const magnitude = Math.abs(interval);
      if (magnitude < 1 || magnitude > FINGERING_RUN_STEP_SEMITONES) break;
      const sign = Math.sign(interval);
      if (direction === 0) direction = sign;
      else if (sign !== direction) break;
      j += 1;
    }
    const runLength = j - i;
    if (runLength >= 2) {
      const fingersAscending = runFingers(runLength, hand);
      for (let onset = 0; onset < runLength; onset++) {
        // Ascending runs list pitches low-to-high; descending runs high-to-low.
        const ascendingIndex = direction >= 0 ? onset : runLength - 1 - onset;
        units[i + onset].fingering = [fingersAscending[ascendingIndex]];
      }
      const last = units[j - 1];
      prevPitch = last.pitches[0];
      prevFinger = last.fingering?.[0];
    } else {
      const finger = isolatedFinger(unit.pitches[0], prevPitch, prevFinger, hand);
      unit.fingering = [finger];
      prevPitch = unit.pitches[0];
      prevFinger = finger;
    }
    i = j;
  }
}

/**
 * Estimates piano fingering and flags hand crosses on assigned voice units.
 *
 * Fingering is estimated per voice (each voice is monophonic-or-chordal) using
 * the hand implied by its staff on a grand staff, or by the clef on a single
 * staff. A hand cross is flagged only on grand-staff parts, where a unit's
 * assigned staff can differ from the staff its pitch center would fall to.
 */
export function estimateFingeringForUnits(
  assignments: AssignedVoiceUnits[],
  clef: NotatedClef | undefined,
  splitPitch: number,
): void {
  for (const assignment of assignments) {
    assignHandFingering(assignment.units, handForStaff(assignment.staff, clef));
    if (assignment.staff === undefined) continue;
    for (const unit of assignment.units) {
      if (staffForMeanPitch(meanPitch(unit.pitches), splitPitch) !== assignment.staff) {
        unit.handCross = true;
      }
    }
  }
}
