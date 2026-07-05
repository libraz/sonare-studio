/**
 * Note-name parsing and formatting for the sample editor's pitch-correction
 * control. Pure helpers: the "tune to note" input accepts either a scientific
 * note name (e.g. `A4`, `C#3`, `Bb2`) or a raw MIDI number. Middle C (`C4`) is
 * MIDI 60, so A4 is MIDI 69 (440 Hz) — matching libsonare's `hzToMidi`.
 */

import { formatPitch, PITCH_CLASS_NAMES, parsePitch } from '@/lib/pitch';

export { PITCH_CLASS_NAMES };

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
  return parsePitch(text);
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
  if (rounded >= 0 && rounded <= 127) return formatPitch(rounded);
  const pitchClass = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return `${PITCH_CLASS_NAMES[pitchClass]}${octave}`;
}
