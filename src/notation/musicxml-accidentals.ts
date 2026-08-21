/**
 * Pitch spelling and the accidentals that follow from it.
 *
 * Which accidental a note carries depends on the key in force and on what the
 * bar has already shown, so spelling and accidental state are worked out over a
 * whole part before any note is written.
 */

import type { NotatedEvent, NotatedMeasure, NotatedPart, NotatedScore } from './model';
import { inferChordRootMidi, noteEventsByVoice, type StaffNumber } from './musicxml-shared';
import {
  type SpelledPitch,
  type Step,
  spellLineInKeySignature,
  spellPitchInKeySignature,
  spellPitchWithContext,
} from './pitch-spelling';
/** Explicit accidental text by event and pitch index within a note/chord. */
export type AccidentalIndex = ReadonlyMap<NotatedEvent, ReadonlyMap<number, string>>;

export type PitchSpellingIndex = ReadonlyMap<NotatedEvent, ReadonlyArray<SpelledPitch>>;

/**
 * Derives one contextual spelling per sounding event/pitch across a whole part.
 *
 * The line is solved per voice over every measure at once, not measure by
 * measure. Which side of the key signature a chromatic run is written on is a
 * property of the run, so a chromatic ascent that crosses a barline would
 * otherwise flip from sharps to flats at the bar it happens to be split on.
 * Measures are grouped into runs sharing one key signature, because a key
 * change genuinely restarts how the line reads.
 *
 * Only the top pitch of an event joins the line: a chord is a vertical
 * sonority rather than a melody, and its top voice is the one carrying the
 * melodic shape. The remaining chord tones keep the chord-root spelling, which
 * reads them as stacked thirds above the root instead of as neighbours in a
 * line they are not part of.
 */
export function buildPartPitchSpellingIndex(
  part: NotatedPart,
  keyFifthsByMeasure: ReadonlyArray<number>,
): PitchSpellingIndex {
  const spellings = new Map<NotatedEvent, ReadonlyArray<SpelledPitch>>();
  let runStart = 0;
  while (runStart < part.measures.length) {
    const keyFifths = keyFifthsByMeasure[runStart];
    let runEnd = runStart;
    while (runEnd + 1 < part.measures.length && keyFifthsByMeasure[runEnd + 1] === keyFifths) {
      runEnd += 1;
    }
    for (const events of noteEventsByVoice(part.measures.slice(runStart, runEnd + 1))) {
      const line = spellLineInKeySignature(
        events.map((event) => ({
          midi: event.pitches[event.pitches.length - 1],
          startBeat: event.startPpq,
          durationBeat: event.durationPpq,
        })),
        keyFifths,
      );
      events.forEach((event, index) => {
        const chordRootMidi = inferChordRootMidi(event.pitches);
        const top = event.pitches.length - 1;
        spellings.set(
          event,
          event.pitches.map((midi, pitchIndex) =>
            pitchIndex === top
              ? line[index]
              : spellPitchWithContext(midi, keyFifths, { chordRootMidi }),
          ),
        );
      });
    }
    runStart = runEnd + 1;
  }
  return spellings;
}

/** Resolves the key signature sounding in each measure of a part. */
export function activeKeyFifthsByMeasure(part: NotatedPart, score: NotatedScore): number[] {
  let active = score.keyFifths;
  return part.measures.map((measure) => {
    active = score.measureKeyFifths?.[measure.index] ?? active;
    return active;
  });
}

/** Builds explicit accidentals only when the visible pitch state changes. */
export function buildAccidentalIndex(
  measure: NotatedMeasure,
  keyFifths: number,
  staffMap: ReadonlyMap<NotatedEvent, StaffNumber> | undefined,
  spellings: PitchSpellingIndex,
): AccidentalIndex {
  const accidentals = new Map<NotatedEvent, Map<number, string>>();
  const state = new Map<string, number>();
  const noteEvents = measure.voices
    .flatMap((voice) => voice.events)
    .filter((event) => event.kind === 'note')
    .sort((a, b) => a.startPpq - b.startPpq || a.voice - b.voice);
  for (const event of noteEvents) {
    const suppressDisplay = event.tieStop;
    const staff = staffMap?.get(event) ?? 1;
    event.pitches.forEach((midi, pitchIndex) => {
      const pitch = spellings.get(event)?.[pitchIndex] ?? spellPitchInKeySignature(midi, keyFifths);
      const key = `${staff}:${pitch.step}:${pitch.octave}`;
      const current = state.get(key) ?? keySignatureAlter(pitch.step, keyFifths);
      if (!suppressDisplay && pitch.alter !== current) {
        const value = accidentalName(pitch.alter);
        const eventAccidentals = accidentals.get(event) ?? new Map<number, string>();
        eventAccidentals.set(pitchIndex, value);
        accidentals.set(event, eventAccidentals);
      }
      // A tied continuation belongs to the prior measure's accidental state;
      // it must not suppress the first newly attacked matching pitch here.
      if (!suppressDisplay && pitch.alter !== current) state.set(key, pitch.alter);
    });
  }
  return accidentals;
}

/** Key-signature alteration for a diatonic step. */
export function keySignatureAlter(step: Step, fifths: number): number {
  const sharpSteps: Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const flatSteps: Step[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  if (fifths > 0) return sharpSteps.slice(0, fifths).includes(step) ? 1 : 0;
  if (fifths < 0) return flatSteps.slice(0, -fifths).includes(step) ? -1 : 0;
  return 0;
}

/** MusicXML accidental name for supported spellings. */
export function accidentalName(alter: number): string {
  if (alter >= 2) return 'double-sharp';
  if (alter > 0) return 'sharp';
  if (alter <= -2) return 'flat-flat';
  if (alter < 0) return 'flat';
  return 'natural';
}

/** Builds an explicit MusicXML accidental element. */
export function accidentalXml(accidental: string | undefined): string {
  return accidental === undefined ? '' : `<accidental>${accidental}</accidental>`;
}

/**
 * Builds the `<pitch>` element for a spelled pitch (alter omitted when 0).
 */
export function pitchXml(pitch: SpelledPitch): string {
  const alter = pitch.alter === 0 ? '' : `<alter>${pitch.alter}</alter>`;
  return `<pitch><step>${pitch.step}</step>${alter}<octave>${pitch.octave}</octave></pitch>`;
}
