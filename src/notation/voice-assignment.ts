/**
 * Voice assignment for the display quantizer: clustered units onto monophonic
 * notated voices, with the drum-set two-voice split and the grand-staff
 * per-staff assignment (pipeline step 3 of the quantizer).
 */

import { assignGrandStaffUnits } from '@/notation/grand-staff';
import type { NotatedClef, NotatedVoiceNumber } from '@/notation/model';
import { type AssignedVoiceUnits, EPSILON, meanPitch, type VoiceUnit } from '@/notation/voice-unit';
import type { MidiSourceIdentity } from '@/project/midi-projection';

/** Drum-set voice group: 1 = upper kit voice, 2 = kick/low-foot voice. */
export function percussionVoiceGroup(pitch: number): 1 | 2 {
  switch (pitch) {
    case 35:
    case 36:
      return 2;
    default:
      return 1;
  }
}

/** Union of two identity lists, keeping first-seen order. */
function mergeSourceIdentities(
  a: readonly MidiSourceIdentity[] | undefined,
  b: readonly MidiSourceIdentity[] | undefined,
): MidiSourceIdentity[] {
  const merged = [...(a ?? [])];
  for (const identity of b ?? []) {
    const known = merged.some(
      (m) =>
        m.clipId === identity.clipId &&
        m.noteId === identity.noteId &&
        m.occurrence === identity.occurrence,
    );
    if (!known) merged.push({ ...identity });
  }
  return merged;
}

/**
 * Pipeline step 3: assign units to at most `maxVoices` monophonic voices.
 *
 * Greedy interval scheduling: for each onset, free voices (lowest number
 * first) receive the simultaneous units in descending pitch order, so among
 * simultaneous onsets the higher pitch lands in voice 1. A unit arriving
 * while every voice is still sounding merges into the busy voice whose
 * sounding event has the nearest mean pitch (ties pick the lower voice):
 * same-onset overflow joins that event as a chord (union of pitches, longer
 * end wins); later-onset overflow truncates the sounding event at the new
 * onset so the voice stays monophonic and the new onset is preserved.
 *
 * Returns one unit list per used voice (no holes: lower voices fill first).
 */
function separateVoices(units: VoiceUnit[], maxVoices: number): VoiceUnit[][] {
  const voices: VoiceUnit[][] = Array.from({ length: maxVoices }, () => []);
  let i = 0;
  while (i < units.length) {
    let j = i;
    while (j < units.length && Math.abs(units[j].startPpq - units[i].startPpq) <= EPSILON) j++;
    const start = units[i].startPpq;
    const free: number[] = [];
    for (let v = 0; v < maxVoices; v++) {
      const last = voices[v][voices[v].length - 1];
      if (!last || last.endPpq <= start + EPSILON) free.push(v);
    }
    for (let u = i; u < j; u++) {
      const unit = units[u];
      const freeVoice = free.shift();
      if (freeVoice !== undefined) {
        voices[freeVoice].push(unit);
        continue;
      }
      // Overflow: every voice is sounding. Merge into the nearest by pitch.
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let v = 0; v < maxVoices; v++) {
        const last = voices[v][voices[v].length - 1];
        const dist = Math.abs(meanPitch(last.pitches) - meanPitch(unit.pitches));
        if (dist < bestDist - EPSILON) {
          best = v;
          bestDist = dist;
        }
      }
      const last = voices[best][voices[best].length - 1];
      if (Math.abs(last.startPpq - unit.startPpq) <= EPSILON) {
        // Same onset: widen the sounding event into a chord.
        last.pitches = [...new Set([...last.pitches, ...unit.pitches])].sort((a, b) => a - b);
        last.channels = [...new Set([...last.channels, ...unit.channels])].sort((a, b) => a - b);
        last.ids = [...new Set([...last.ids, ...unit.ids])].sort((a, b) => a - b);
        last.sourceIdentities = mergeSourceIdentities(last.sourceIdentities, unit.sourceIdentities);
        last.velocity = Math.max(last.velocity, unit.velocity);
        last.endPpq = Math.max(last.endPpq, unit.endPpq);
      } else {
        // Later onset: cut the sounding event short and start the new one.
        last.endPpq = unit.startPpq;
        voices[best].push(unit);
      }
    }
    i = j;
  }
  return voices.filter((v) => v.length > 0);
}

/**
 * Assigns a drum-set part to its conventional two voices: upper kit material
 * is voice 1 and kick/low-foot material is voice 2. Each group remains
 * monophonic, so overlapping notes in one group retain the normal overflow
 * handling instead of moving between the two engraved voices.
 */
function separatePercussionVoices(units: VoiceUnit[]): AssignedVoiceUnits[] {
  const byGroup: Record<1 | 2, VoiceUnit[]> = { 1: [], 2: [] };
  for (const unit of units) {
    byGroup[percussionVoiceGroup(unit.pitches[0])].push(unit);
  }
  return ([1, 2] as const).flatMap((group) => {
    const groupUnits = separateVoices(byGroup[group], 1)[0];
    return groupUnits ? [{ voice: group as NotatedVoiceNumber, units: groupUnits }] : [];
  });
}

function grandStaffVoiceNumber(staff: 1 | 2, index: number): NotatedVoiceNumber {
  const voice = staff === 1 ? index + 1 : index + 3;
  if (voice < 1 || voice > 4) {
    throw new RangeError(`quantizeToScore: grand-staff voice index out of range: ${voice}`);
  }
  return voice as NotatedVoiceNumber;
}

/**
 * Assigns clustered units to notated voices.
 *
 * Single-staff parts keep the historical one-pool assignment. Grand-staff
 * parts split units by pitch center first, then assign voices independently
 * on each staff: upper staff uses voices 1/2, lower staff uses voices 3/4.
 */
export function assignVoiceUnits(
  units: VoiceUnit[],
  clef: NotatedClef | undefined,
  maxVoices: number,
  grandStaffSplitPitch: number,
  percussion: boolean,
): AssignedVoiceUnits[] {
  if (clef !== 'grand') {
    if (percussion && maxVoices >= 2) return separatePercussionVoices(units);
    return separateVoices(units, maxVoices).map((voiceUnits, index) => ({
      voice: (index + 1) as NotatedVoiceNumber,
      units: voiceUnits,
    }));
  }

  const { upper, lower } = assignGrandStaffUnits(units, grandStaffSplitPitch);
  const perStaffVoices = Math.min(2, maxVoices);
  const assignments: AssignedVoiceUnits[] = [];
  for (const [staff, staffUnits] of [
    [1, upper],
    [2, lower],
  ] as const) {
    const voices = separateVoices(staffUnits, perStaffVoices);
    // A grand staff must have a complete rest voice on both staves even when
    // one hand is silent for the entire clip. This keeps the MusicXML part
    // structurally complete and gives the serializer an explicit staff target.
    if (voices.length === 0) {
      assignments.push({ voice: grandStaffVoiceNumber(staff, 0), staff, units: [] });
      continue;
    }
    voices.forEach((voiceUnits, index) => {
      assignments.push({ voice: grandStaffVoiceNumber(staff, index), staff, units: voiceUnits });
    });
  }
  for (const staff of [1, 2] as const) {
    if (!assignments.some((assignment) => assignment.staff === staff)) {
      assignments.push({ voice: grandStaffVoiceNumber(staff, 0), staff, units: [] });
    }
  }
  assignments.sort((a, b) => a.voice - b.voice);
  return assignments;
}
