/**
 * Scale (root + mode) helpers for the sample editor's "tune to scale" control.
 *
 * libsonare's `scaleQuantizeMidi(root, modeMask, midi)` takes a 12-bit mask of
 * scale degrees expressed as semitone intervals *relative to the root* (bit i
 * set = the pitch `(root + i) mod 12` is in the scale). These helpers build that
 * mask for the seven diatonic modes (matching libsonare's `Mode` ordinals) and
 * provide the root/mode option lists the picker renders.
 */

import { type NoteNameSystem, namedScaleMask, type ScaleName } from '@libraz/libcantus';
import { pitchClassNames } from './note-names';

/**
 * Diatonic modes in libsonare's `Mode` ordinal order, each addressed by its
 * name in the shared scale vocabulary rather than by intervals written out
 * here, so this picker and the key editor cannot drift on what a mode is.
 */
const MODES: ReadonlyArray<{ name: string; scale: ScaleName }> = [
  { name: 'Major', scale: 'major' },
  { name: 'Minor', scale: 'naturalMinor' },
  { name: 'Dorian', scale: 'dorian' },
  { name: 'Phrygian', scale: 'phrygian' },
  { name: 'Lydian', scale: 'lydian' },
  { name: 'Mixolydian', scale: 'mixolydian' },
  { name: 'Locrian', scale: 'locrian' },
];

/**
 * Builds the relative-interval mode mask for a `Mode` ordinal (0 = Major …
 * 6 = Locrian). Unknown ordinals fall back to the major scale.
 *
 * @param mode - The `Mode` ordinal.
 * @returns The 12-bit mask consumed by `scaleQuantizeMidi`.
 */
export function modeMaskFor(mode: number): number {
  const mask = namedScaleMask((MODES[mode] ?? MODES[0]).scale);
  if (mask === undefined) throw new RangeError(`Unknown scale for mode ordinal ${mode}`);
  return mask;
}

/**
 * Root-note options (`C` … `B`) keyed by pitch class for the scale picker.
 *
 * A function rather than a constant so the picker can be rebuilt when the
 * note-name system changes.
 *
 * @param system - Note-name system; English by default.
 */
export function rootOptions(
  system: NoteNameSystem = 'english',
): ReadonlyArray<{ value: string; label: string }> {
  return pitchClassNames(system).map((name, pc) => ({ value: String(pc), label: name }));
}

/** Mode options keyed by `Mode` ordinal for the scale picker. */
export const MODE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = MODES.map(
  (mode, ordinal) => ({ value: String(ordinal), label: mode.name }),
);

/**
 * Display name of a scale, e.g. `C Major`, `A Minor`.
 *
 * @param root - Root pitch class.
 * @param mode - `Mode` ordinal.
 * @param system - Note-name system for the root; English by default.
 */
export function scaleName(root: number, mode: number, system: NoteNameSystem = 'english'): string {
  const pc = ((root % 12) + 12) % 12;
  return `${pitchClassNames(system)[pc]} ${(MODES[mode] ?? MODES[0]).name}`;
}
