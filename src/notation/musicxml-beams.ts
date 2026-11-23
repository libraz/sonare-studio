/**
 * Beaming: which notes are beamed together, and at what level.
 *
 * Groups follow the meter rather than the note values, so the reading of a bar
 * is decided here and the serializer only writes out what this decided.
 */

import { maxOf } from '@/lib/math';
import {
  beatOriginPpq,
  type NotatedEvent,
  type NotatedMeasure,
  type NotatedTimeSig,
  type NotatedVoice,
} from './model';
import { PPQ_EPSILON, type StaffNumber } from './musicxml-shared';
/** MusicXML beam level per beammable note value. */
export const BEAM_LEVEL_BY_BASE: Readonly<Record<string, number | undefined>> = {
  whole: undefined,
  half: undefined,
  quarter: undefined,
  eighth: 1,
  '16th': 2,
  '32nd': 3,
  '64th': 4,
};

/** Beam marks keyed by event, one array entry per MusicXML beam level. */
export type BeamIndex = ReadonlyMap<NotatedEvent, ReadonlyArray<string>>;

/**
 * Computes explicit MusicXML beam markings for each voice. Consecutive
 * beammable notes and short rests are grouped within the same staff; unbeammable
 * values break a group, leaving isolated short notes as flagged notes.
 */
export function buildBeamIndex(
  voice: NotatedVoice,
  measure: NotatedMeasure,
  staffMap: ReadonlyMap<NotatedEvent, StaffNumber> | undefined,
): BeamIndex {
  const beams = new Map<NotatedEvent, string[]>();
  const groupLengths = beamGroupLengthsPpq(measure.timeSig);
  let group: NotatedEvent[] = [];
  let groupStaff: StaffNumber | undefined;
  const flush = () => {
    if (group.filter((event) => event.kind === 'note').length >= 2) assignBeams(group, beams);
    group = [];
    groupStaff = undefined;
  };
  for (const event of voice.events) {
    const staff = staffMap?.get(event);
    const startsNewBeatGroup =
      group.length > 0 && isBeamGroupBoundary(event.startPpq, measure, groupLengths);
    if (beamLevel(event) === 0 || staff !== groupStaff || startsNewBeatGroup) {
      flush();
      if (beamLevel(event) > 0) {
        group = [event];
        groupStaff = staff;
      }
      continue;
    }
    group.push(event);
  }
  flush();
  return beams;
}

/**
 * Returns additive beam-group lengths. Compound meters group by dotted beats;
 * irregular x/8 and x/16 meters prefer a leading group of three, then groups
 * of two (for example 5/8 = 3+2 and 7/8 = 3+2+2).
 */
export function beamGroupLengthsPpq(timeSig: NotatedTimeSig): number[] {
  const beatLen = 4 / timeSig.beatUnit;
  if (timeSig.beatUnit < 8) return Array.from({ length: timeSig.beats }, () => beatLen);

  const groups: number[] = [];
  let remaining = timeSig.beats;
  while (remaining > 0) {
    if (remaining === 4) {
      groups.push(2, 2);
      remaining = 0;
    } else if (remaining === 2) {
      groups.push(2);
      remaining = 0;
    } else if (remaining >= 3) {
      groups.push(3);
      remaining -= 3;
    } else {
      groups.push(1);
      remaining--;
    }
  }
  return groups.map((beats) => beats * beatLen);
}

/**
 * Returns true for additive beam-group boundaries after the measure start. The
 * groups are laid from the measure's beat origin, so a pickup's groups are the
 * ones of the bar it completes.
 */
export function isBeamGroupBoundary(
  ppq: number,
  measure: NotatedMeasure,
  groupLengths: readonly number[],
): boolean {
  if (ppq <= measure.startPpq + PPQ_EPSILON) return false;
  let boundary = beatOriginPpq(measure);
  for (const length of groupLengths) {
    boundary += length;
    if (Math.abs(ppq - boundary) < PPQ_EPSILON) return true;
    if (ppq < boundary) return false;
  }
  return false;
}

/** Returns the number of beams required by an event's notated value. */
export function beamLevel(event: NotatedEvent): number {
  return BEAM_LEVEL_BY_BASE[event.value.base] ?? 0;
}

/** Assigns first-level beams plus secondary hook/continue marks for one group. */
export function assignBeams(group: NotatedEvent[], beams: Map<NotatedEvent, string[]>): void {
  const maxLevel = maxOf(group.map(beamLevel));
  for (let level = 1; level <= maxLevel; level++) {
    const members = group.filter((event) => beamLevel(event) >= level);
    if (members.length === 0) continue;
    for (const event of members) {
      const index = members.indexOf(event);
      const previous = members[index - 1];
      const next = members[index + 1];
      const previousAdjacent =
        previous !== undefined &&
        Math.abs(previous.startPpq + previous.durationPpq - event.startPpq) < PPQ_EPSILON;
      const nextAdjacent =
        next !== undefined &&
        Math.abs(event.startPpq + event.durationPpq - next.startPpq) < PPQ_EPSILON;
      let value: string;
      if (previousAdjacent && nextAdjacent) value = 'continue';
      else if (nextAdjacent) value = 'begin';
      else if (previousAdjacent) value = 'end';
      else value = index === 0 ? 'forward hook' : 'backward hook';
      const eventBeams = beams.get(event) ?? [];
      eventBeams[level - 1] = value;
      beams.set(event, eventBeams);
    }
  }
}

/** Builds explicit MusicXML beam elements, or an empty string for flagged notes. */
export function beamXml(beams: ReadonlyArray<string>): string {
  let xml = '';
  beams.forEach((value, index) => {
    if (value !== undefined) {
      xml += `<beam number="${index + 1}">${value}</beam>`;
    }
  });
  return xml;
}
