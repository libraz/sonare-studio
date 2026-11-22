/**
 * The few pieces the MusicXML writer's modules share.
 *
 * Beaming, accidentals and percussion each own their part of the format, but
 * all of them need to say which staff a note sits on and to walk a part's
 * events voice by voice. These live apart so none of those modules has to
 * import the serializer that uses them.
 */

import { pitchClassOf } from '@/lib/pitch';
import type { NotatedEvent, NotatedMeasure, NotatedVoiceNumber } from './model';

/** Staff number within a grand staff (1 = treble, 2 = bass). */
export type StaffNumber = 1 | 2;

/** Comparison tolerance for PPQ arithmetic on IEEE doubles. */
export const PPQ_EPSILON = 1e-9;

export interface ScoreInstrumentDefinition {
  id: string;
  name: string;
  channel: number;
  unpitched?: number;
}

/** Collects the sounding events of a measure range into one list per voice. */
export function noteEventsByVoice(measures: ReadonlyArray<NotatedMeasure>): NotatedEvent[][] {
  const byVoice = new Map<NotatedVoiceNumber, NotatedEvent[]>();
  for (const measure of measures) {
    for (const voice of measure.voices) {
      for (const event of voice.events) {
        if (event.kind !== 'note' || event.pitches.length === 0) continue;
        const events = byVoice.get(voice.voice);
        if (events === undefined) byVoice.set(voice.voice, [event]);
        else events.push(event);
      }
    }
  }
  return [...byVoice.values()];
}

/** Prefers a tertian root over the lowest pitch so inversions spell correctly. */
export function inferChordRootMidi(pitches: readonly number[]): number | undefined {
  if (pitches.length < 2) return undefined;
  const chordIntervals = new Set([0, 3, 4, 6, 7, 8, 10, 11]);
  let root = pitches[0];
  let bestScore = -1;
  for (const candidate of pitches) {
    const score = pitches.reduce(
      (total, pitch) => total + (chordIntervals.has(pitchClassOf(pitch - candidate)) ? 1 : 0),
      0,
    );
    if (score > bestScore) {
      root = candidate;
      bestScore = score;
    }
  }
  return root;
}

/** Formats BPM with at most one decimal place. */
export function tempoText(bpm: number): string {
  const rounded = Math.round(bpm * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
