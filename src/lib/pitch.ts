/**
 * Pitch-name helpers for note fields (e.g., the piano-roll Info Line).
 *
 * Convention: scientific pitch notation with middle C (MIDI 60) = C4, so the
 * full MIDI range reads C-1 (0) through G9 (127). Note spelling and note
 * arithmetic come from libcantus; this module owns the studio's input
 * contract — which note-name shapes are accepted, and the MIDI range a pitch
 * field may hold.
 */

import { formatNote, midiToNote, noteNames, noteToMidi, parseNote } from '@libraz/libcantus';

/** Sharp-based pitch class names indexed by pitch class (0 = C ... 11 = B). */
export const PITCH_CLASS_NAMES: readonly string[] = noteNames(
  Array.from({ length: 12 }, (_unused, pitchClass) => {
    // Drop the octave so each note names a bare pitch class.
    const { letter, alter } = midiToNote(pitchClass, 'sharp');
    return { letter, alter };
  }),
);

/** ASCII accidental libcantus expects for each accepted accidental character. */
const ACCIDENTALS: Readonly<Record<string, string>> = { '#': '#', '♯': '#', b: 'b', '♭': 'b' };

/** Note-name pattern: letter, optional accidental, octave (-1..9, two digits max). */
const NOTE_NAME_PATTERN = /^([a-g])([#♯b♭]?)(-?\d{1,2})$/i;

/** Plain integer pattern (optional sign). */
const INTEGER_PATTERN = /^[+-]?\d+$/;

/**
 * Formats a MIDI note number as a sharp-spelled scientific pitch name
 * (60 → "C4", 61 → "C#4", 0 → "C-1", 127 → "G9").
 *
 * @param midi MIDI note number (integer, 0-127).
 * @returns The pitch name.
 * @throws RangeError when `midi` is not an integer in [0, 127].
 */
export function formatPitch(midi: number): string {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
    throw new RangeError(`MIDI pitch must be an integer in [0, 127], got ${midi}`);
  }
  return formatNote(midiToNote(midi, 'sharp'));
}

/**
 * Parses a pitch typed as either a note name ("C#4", "db3", "B♭-1") or a
 * plain MIDI note number ("60"). Case-insensitive; surrounding whitespace is
 * ignored. Enharmonic spellings that cross an octave boundary (e.g., "Cb4",
 * "B#3") resolve arithmetically.
 *
 * @param text User input to parse.
 * @returns The MIDI note number, or null when the text is not a pitch or
 *   falls outside [0, 127].
 */
export function parsePitch(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (INTEGER_PATTERN.test(trimmed)) {
    const value = Number.parseInt(trimmed, 10);
    return value >= 0 && value <= 127 ? value : null;
  }
  const match = NOTE_NAME_PATTERN.exec(trimmed);
  if (!match) return null;
  // The pattern above is the accepted input, so hand libcantus a canonical
  // spelling: it reads only ASCII accidentals, and takes an uppercase "B" as a
  // note letter rather than a flat.
  const name = `${match[1].toUpperCase()}${ACCIDENTALS[match[2].toLowerCase()] ?? ''}${match[3]}`;
  const midi = noteToMidi(parseNote(name));
  return midi >= 0 && midi <= 127 ? midi : null;
}
