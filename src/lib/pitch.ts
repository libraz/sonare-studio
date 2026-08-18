/**
 * Pitch-name helpers for note fields (e.g., the piano-roll Info Line).
 *
 * Convention: scientific pitch notation with middle C (MIDI 60) = C4, so the
 * full MIDI range reads C-1 (0) through G9 (127). Note spelling and note
 * arithmetic come from libcantus; this module owns the studio's input
 * contract — which note-name shapes are accepted, and the MIDI range a pitch
 * field may hold.
 *
 * Every formatter takes the note-name system as an argument and defaults to
 * English, so a caller that names no system — serialization, export and any
 * text parsed back — keeps producing ASCII English names.
 */

import {
  formatNote,
  midiToNote,
  type NoteNameSystem,
  noteToMidi,
  parseNote,
  tryParseNote,
} from '@libraz/libcantus';

export type { NoteNameSystem };

/**
 * Sharp-based pitch class names indexed by pitch class (0 = C ... 11 = B).
 *
 * Spelled out rather than derived at module scope: importing this module must
 * not evaluate libcantus. The spec pins these against the library's own note
 * names, so a drift in spelling convention still fails the suite.
 */
export const PITCH_CLASS_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

/**
 * Pitch-class names of the non-English systems, built on first use.
 *
 * Each table is derived from {@link PITCH_CLASS_NAMES}, so a system's names
 * stay aligned with the English spelling the rest of the app indexes by.
 */
const PITCH_CLASS_NAMES_BY_SYSTEM = new Map<NoteNameSystem, ReadonlyArray<string>>();

/**
 * Pitch-class names (index 0 = C ... 11 = B) in a note-name system.
 *
 * @param system Note-name system; English by default.
 * @returns The 12 names, sharp-spelled, without an octave.
 */
export function pitchClassNames(system: NoteNameSystem = 'english'): ReadonlyArray<string> {
  if (system === 'english') return PITCH_CLASS_NAMES;
  const cached = PITCH_CLASS_NAMES_BY_SYSTEM.get(system);
  if (cached) return cached;
  const names = PITCH_CLASS_NAMES.map((name) => formatNote(parseNote(name), { system }));
  PITCH_CLASS_NAMES_BY_SYSTEM.set(system, names);
  return names;
}

/** Diatonic letters in libcantus letter order (index = `Note.letter`). */
const DIATONIC_LETTERS = 'CDEFGAB';

/**
 * Formats an already-spelled pitch (a diatonic step letter plus a chromatic
 * alteration) in a note-name system.
 *
 * Spelling decisions belong to the caller — key signatures, chord degrees —
 * so the step and alteration are taken as given and only the name is written.
 *
 * @param spelled Step letter (`'C'`..`'B'`), alteration in semitones, and an
 *   optional scientific octave.
 * @param system Note-name system; English by default.
 * @returns The note name, including the octave when present.
 * @throws RangeError when `step` is not a diatonic letter.
 */
export function formatSpelledPitch(
  spelled: Readonly<{ step: string; alter: number; octave?: number }>,
  system: NoteNameSystem = 'english',
): string {
  const letter = DIATONIC_LETTERS.indexOf(spelled.step.toUpperCase());
  if (letter < 0) throw new RangeError(`Not a diatonic step letter: ${spelled.step}`);
  return formatNote({ letter, alter: spelled.alter, octave: spelled.octave }, { system });
}

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
 * The octave follows the name in every system, so a Japanese reading of 61 is
 * "嬰ハ4".
 *
 * @param midi MIDI note number (integer, 0-127).
 * @param system Note-name system; English by default.
 * @returns The pitch name.
 * @throws RangeError when `midi` is not an integer in [0, 127].
 */
export function formatPitch(midi: number, system: NoteNameSystem = 'english'): string {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
    throw new RangeError(`MIDI pitch must be an integer in [0, 127], got ${midi}`);
  }
  return formatNote(midiToNote(midi, 'sharp'), { system });
}

/**
 * Parses a pitch typed as either a note name ("C#4", "db3", "B♭-1") or a
 * plain MIDI note number ("60"). Case-insensitive; surrounding whitespace is
 * ignored. Enharmonic spellings that cross an octave boundary (e.g., "Cb4",
 * "B#3") resolve arithmetically.
 *
 * The English shapes are read first and are always accepted, whichever system
 * is asked for: an ASCII name a user types means the same pitch on every
 * setting, and only a name English cannot read falls through to the other
 * system. That keeps "b3" the B natural it has always been rather than a
 * German B flat, at the cost of requiring "H3" for that note.
 *
 * @param text User input to parse.
 * @param system Additional note-name system to accept; English by default.
 * @returns The MIDI note number, or null when the text is not a pitch or
 *   falls outside [0, 127].
 */
export function parsePitch(text: string, system: NoteNameSystem = 'english'): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (INTEGER_PATTERN.test(trimmed)) {
    const value = Number.parseInt(trimmed, 10);
    return value >= 0 && value <= 127 ? value : null;
  }
  const match = NOTE_NAME_PATTERN.exec(trimmed);
  if (!match) return system === 'english' ? null : parseSystemPitch(trimmed, system);
  // The pattern above is the accepted input, so hand libcantus a canonical
  // spelling: it reads only ASCII accidentals, and takes an uppercase "B" as a
  // note letter rather than a flat.
  const name = `${match[1].toUpperCase()}${ACCIDENTALS[match[2].toLowerCase()] ?? ''}${match[3]}`;
  const midi = noteToMidi(parseNote(name));
  return midi >= 0 && midi <= 127 ? midi : null;
}

/**
 * Reads a note name in a non-English system. A pitch field names one register,
 * so a name without an octave stays rejected here as it is in English.
 */
function parseSystemPitch(text: string, system: NoteNameSystem): number | null {
  const parsed = tryParseNote(text, { system });
  if (!parsed.ok || parsed.value.octave === undefined) return null;
  const midi = noteToMidi(parsed.value);
  return midi >= 0 && midi <= 127 ? midi : null;
}
