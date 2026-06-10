/**
 * Pitch-name helpers for note fields (e.g., the piano-roll Info Line).
 *
 * Convention: scientific pitch notation with middle C (MIDI 60) = C4, so the
 * full MIDI range reads C-1 (0) through G9 (127).
 */

/** Sharp-based pitch class names indexed by pitch class (0 = C ... 11 = B). */
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

/** Natural pitch class for each note letter. */
const LETTER_TO_PITCH_CLASS: Readonly<Record<string, number>> = {
  c: 0,
  d: 2,
  e: 4,
  f: 5,
  g: 7,
  a: 9,
  b: 11,
};

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
  const octave = Math.floor(midi / 12) - 1;
  return `${PITCH_CLASS_NAMES[midi % 12]}${octave}`;
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
  const pitchClass = LETTER_TO_PITCH_CLASS[match[1].toLowerCase()];
  const accidentalChar = match[2].toLowerCase();
  const accidental =
    accidentalChar === '#' || accidentalChar === '♯'
      ? 1
      : accidentalChar === 'b' || accidentalChar === '♭'
        ? -1
        : 0;
  const octave = Number.parseInt(match[3], 10);
  const midi = (octave + 1) * 12 + pitchClass + accidental;
  return midi >= 0 && midi <= 127 ? midi : null;
}
