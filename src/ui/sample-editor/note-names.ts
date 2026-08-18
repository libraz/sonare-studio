/**
 * Note-name parsing and formatting for the sample editor's pitch-correction
 * control. Pure helpers: the "tune to note" input accepts either a scientific
 * note name (e.g. `A4`, `C#3`, `Bb2`) or a raw MIDI number. Middle C (`C4`) is
 * MIDI 60, so A4 is MIDI 69 (440 Hz) — matching libsonare's `hzToMidi`.
 */

import type { NoteNameSystem } from '@libraz/libcantus';
import { formatPitch, PITCH_CLASS_NAMES, parsePitch, pitchClassNames } from '@/lib/pitch';

export { PITCH_CLASS_NAMES, pitchClassNames };

/**
 * Parses a target note into a MIDI number in [0, 127].
 *
 * Accepts a scientific note name (`A4`, `C#3`, `Bb2`, `Eb-1`; `#`/`♯` sharpen,
 * `b`/`♭` flatten), a name in `system`, or a plain MIDI integer (`69`).
 * Whitespace is tolerated. Returns null for empty, unparseable or
 * out-of-range input.
 *
 * @param text - Raw input from the tune control.
 * @param system - Additional note-name system to accept; English by default.
 * @returns The MIDI note number, or null when no valid note was given.
 */
export function parseMidiNote(text: string, system: NoteNameSystem = 'english'): number | null {
  return parsePitch(text, system);
}

/**
 * Formats a MIDI number as a scientific note name (e.g. 60 → `C4`, 69 → `A4`).
 * Sharps are used for the black keys.
 *
 * @param midi - MIDI note number (rounded to the nearest integer).
 * @param system - Note-name system; English by default.
 * @returns The note name.
 */
export function formatMidiNote(midi: number, system: NoteNameSystem = 'english'): string {
  const rounded = Math.round(midi);
  if (rounded >= 0 && rounded <= 127) return formatPitch(rounded, system);
  const pitchClass = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return `${pitchClassNames(system)[pitchClass]}${octave}`;
}
