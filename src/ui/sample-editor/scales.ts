/**
 * Scale (root + mode) helpers for the sample editor's "tune to scale" control.
 *
 * libsonare's `scaleQuantizeMidi(root, modeMask, midi)` takes a 12-bit mask of
 * scale degrees expressed as semitone intervals *relative to the root* (bit i
 * set = the pitch `(root + i) mod 12` is in the scale). These helpers build that
 * mask for the seven diatonic modes (matching libsonare's `Mode` ordinals) and
 * provide the root/mode option lists the picker renders.
 */

import { PITCH_CLASS_NAMES } from './note-names';

/**
 * Diatonic modes in libsonare's `Mode` ordinal order, each with its semitone
 * intervals from the root. Major's mask is `0b101010110101`, matching the
 * `ScaleQuantizer` default.
 */
const MODES: ReadonlyArray<{ name: string; intervals: ReadonlyArray<number> }> = [
  { name: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'Minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'Phrygian', intervals: [0, 1, 3, 5, 7, 8, 10] },
  { name: 'Lydian', intervals: [0, 2, 4, 6, 7, 9, 11] },
  { name: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'Locrian', intervals: [0, 1, 3, 5, 6, 8, 10] },
];

/**
 * Builds the relative-interval mode mask for a `Mode` ordinal (0 = Major …
 * 6 = Locrian). Unknown ordinals fall back to the major scale.
 *
 * @param mode - The `Mode` ordinal.
 * @returns The 12-bit mask consumed by `scaleQuantizeMidi`.
 */
export function modeMaskFor(mode: number): number {
  const intervals = (MODES[mode] ?? MODES[0]).intervals;
  let mask = 0;
  for (const interval of intervals) mask |= 1 << interval;
  return mask;
}

/** Root-note options (`C` … `B`) keyed by pitch class for the scale picker. */
export const ROOT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = PITCH_CLASS_NAMES.map(
  (name, pc) => ({ value: String(pc), label: name }),
);

/** Mode options keyed by `Mode` ordinal for the scale picker. */
export const MODE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = MODES.map(
  (mode, ordinal) => ({ value: String(ordinal), label: mode.name }),
);

/** Display name of a scale, e.g. `C Major`, `A Minor`. */
export function scaleName(root: number, mode: number): string {
  const pc = ((root % 12) + 12) % 12;
  return `${PITCH_CLASS_NAMES[pc]} ${(MODES[mode] ?? MODES[0]).name}`;
}
