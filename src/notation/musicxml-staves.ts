/**
 * Staff assignment for grand-staff parts: which of the two staves every note
 * and rest of a part is written on.
 */

import { staffForMeanPitch } from './grand-staff';
import type { NotatedEvent, NotatedPart, NotatedVoiceNumber } from './model';
import type { StaffNumber } from './musicxml-shared';

/** MIDI split point between the staves of a grand staff (middle C / C4). */
const GRAND_STAFF_SPLIT_MIDI = 60;

/** The staff an override or the event itself names, if any. */
function assignedStaff(
  event: NotatedEvent,
  overrides: ReadonlyMap<NotatedEvent, StaffNumber>,
): StaffNumber | undefined {
  return overrides.get(event) ?? (event.staff === 1 || event.staff === 2 ? event.staff : undefined);
}

/**
 * Returns the staff a note event belongs to in a grand staff: treble when the
 * chord's mean pitch reaches middle C, bass otherwise.
 *
 * Using the centre of mass rather than the lowest pitch keeps a chord whose
 * body sits above middle C on the treble staff even when its lowest note dips
 * just below the split, which matches how a player reads a right-hand voicing.
 * A single note reduces to comparing that pitch against the split point.
 */
function noteStaff(
  event: NotatedEvent,
  overrides: ReadonlyMap<NotatedEvent, StaffNumber>,
): StaffNumber {
  const assigned = assignedStaff(event, overrides);
  if (assigned !== undefined) return assigned;
  if (event.pitches.length === 0) return 1;
  const mean = event.pitches.reduce((sum, pitch) => sum + pitch, 0) / event.pitches.length;
  return staffForMeanPitch(mean, GRAND_STAFF_SPLIT_MIDI);
}

/**
 * Assigns a staff to every event of a grand-staff part. Notes split at
 * middle C by their mean pitch; a rest with an assigned staff keeps it, other
 * rests inherit the staff of the preceding note in the same voice (chained across measures), leading rests adopt the
 * first note's staff, and all-rest voices default to staff 1.
 */
export function buildStaffMap(
  part: NotatedPart,
  overrides: ReadonlyMap<NotatedEvent, StaffNumber> = new Map(),
): Map<NotatedEvent, StaffNumber> {
  const staffMap = new Map<NotatedEvent, StaffNumber>();
  const eventsByVoice = new Map<NotatedVoiceNumber, NotatedEvent[]>();
  for (const measure of part.measures) {
    for (const voice of measure.voices) {
      const list = eventsByVoice.get(voice.voice);
      if (list === undefined) {
        eventsByVoice.set(voice.voice, [...voice.events]);
      } else {
        list.push(...voice.events);
      }
    }
  }
  for (const events of eventsByVoice.values()) {
    let current: StaffNumber | undefined;
    const leadingRests: NotatedEvent[] = [];
    for (const event of events) {
      if (event.kind === 'note') {
        const staff = noteStaff(event, overrides);
        for (const rest of leadingRests) {
          staffMap.set(rest, staff);
        }
        leadingRests.length = 0;
        staffMap.set(event, staff);
        current = staff;
      } else {
        const assigned = assignedStaff(event, overrides);
        if (assigned !== undefined) staffMap.set(event, assigned);
        else if (current === undefined) leadingRests.push(event);
        else staffMap.set(event, current);
      }
    }
    for (const rest of leadingRests) {
      staffMap.set(rest, 1);
    }
  }
  return staffMap;
}
