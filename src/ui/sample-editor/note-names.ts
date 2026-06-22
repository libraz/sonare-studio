/**
 * Note-name parsing and formatting for the sample editor's pitch-correction
 * control. Pure helpers: the "tune to note" input accepts either a scientific
 * note name (e.g. `A4`, `C#3`, `Bb2`) or a raw MIDI number. Middle C (`C4`) is
 * MIDI 60, so A4 is MIDI 69 (440 Hz) — matching libsonare's `hzToMidi`.
 */

/** Pitch-class names (sharps), index = pitch class with C = 0. */
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

/** Semitone offset of each note letter from C within an octave. */
const LETTER_SEMITONES: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/**
 * Parses a target note into a MIDI number in [0, 127].
 *
 * Accepts a scientific note name (`A4`, `C#3`, `Bb2`, `Eb-1`; `#`/`♯` sharpen,
 * `b`/`♭` flatten) or a plain MIDI integer (`69`). Whitespace is tolerated.
 * Returns null for empty, unparseable or out-of-range input.
 *
 * @param text - Raw input from the tune control.
 * @returns The MIDI note number, or null when no valid note was given.
 */
export function parseMidiNote(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // A bare integer is treated as a MIDI number.
  if (/^\d+$/.test(trimmed)) {
    const midi = Number(trimmed);
    return midi >= 0 && midi <= 127 ? midi : null;
  }
  const match = /^([A-Ga-g])([#♯bB♭]*)(-?\d+)$/.exec(trimmed);
  if (!match) return null;
  const [, letter, accidentals, octaveText] = match;
  let semitone = LETTER_SEMITONES[letter.toUpperCase()];
  for (const accidental of accidentals) {
    if (accidental === '#' || accidental === '♯') semitone += 1;
    else semitone -= 1; // 'b', 'B' or '♭'
  }
  const midi = (Number(octaveText) + 1) * 12 + semitone;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/**
 * Formats a MIDI number as a scientific note name (e.g. 60 → `C4`, 69 → `A4`).
 * Sharps are used for the black keys.
 *
 * @param midi - MIDI note number (rounded to the nearest integer).
 * @returns The note name.
 */
export function formatMidiNote(midi: number): string {
  const rounded = Math.round(midi);
  const pitchClass = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return `${PITCH_CLASS_NAMES[pitchClass]}${octave}`;
}
