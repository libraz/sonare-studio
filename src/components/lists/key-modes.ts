/**
 * Key / mode helpers for the key editor, built on the 12-bit interval masks
 * the scale-highlight configuration uses (bit n = interval n semitones above
 * the root is in the scale). Pure module (no DOM, no framework imports).
 */

import { MAJOR_MODE_MASK } from '@/project/types';

/** Pitch-class display names indexed by pitch class (C = 0). */
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

/** One selectable diatonic mode. */
export interface KeyModeChoice {
  /** Stable identifier used as the select value. */
  id: string;
  /** Display label. */
  label: string;
  /** Semitone offset of the mode's tonic above the major-scale tonic. */
  semitoneOffset: number;
}

/** The seven diatonic modes, each derived from the major mask by rotation. */
export const KEY_MODE_CHOICES: ReadonlyArray<KeyModeChoice> = [
  { id: 'major', label: 'Major (Ionian)', semitoneOffset: 0 },
  { id: 'dorian', label: 'Dorian', semitoneOffset: 2 },
  { id: 'phrygian', label: 'Phrygian', semitoneOffset: 4 },
  { id: 'lydian', label: 'Lydian', semitoneOffset: 5 },
  { id: 'mixolydian', label: 'Mixolydian', semitoneOffset: 7 },
  { id: 'minor', label: 'Minor (Aeolian)', semitoneOffset: 9 },
  { id: 'locrian', label: 'Locrian', semitoneOffset: 11 },
];

/**
 * Rotates a 12-bit interval mask so the scale degree `semitoneOffset`
 * semitones above the original root becomes the new root: bit i of the
 * result is bit (i + semitoneOffset) mod 12 of the input.
 *
 * @param mask 12-bit interval mask.
 * @param semitoneOffset Rotation amount in semitones (any integer).
 * @returns The rotated 12-bit mask.
 */
export function rotateModeMask(mask: number, semitoneOffset: number): number {
  const shift = ((semitoneOffset % 12) + 12) % 12;
  let rotated = 0;
  for (let i = 0; i < 12; i++) {
    if (mask & (1 << ((i + shift) % 12))) rotated |= 1 << i;
  }
  return rotated;
}

/**
 * Returns the interval mask of a diatonic mode.
 *
 * @param id One of the {@link KEY_MODE_CHOICES} ids.
 * @returns The mode's 12-bit interval mask.
 */
export function modeMaskForChoice(id: string): number {
  const choice = KEY_MODE_CHOICES.find((c) => c.id === id);
  if (!choice) throw new RangeError(`Unknown key mode: ${id}`);
  return rotateModeMask(MAJOR_MODE_MASK, choice.semitoneOffset);
}

/**
 * Finds the diatonic mode matching an interval mask.
 *
 * @param mask 12-bit interval mask.
 * @returns The matching mode id, or null for non-diatonic masks.
 */
export function matchModeChoiceId(mask: number): string | null {
  for (const choice of KEY_MODE_CHOICES) {
    if (rotateModeMask(MAJOR_MODE_MASK, choice.semitoneOffset) === mask) return choice.id;
  }
  return null;
}

/**
 * Builds a display label such as "C Major (Ionian)" or "A Minor (Aeolian)".
 *
 * @param rootPc Root pitch class (0-11, C = 0).
 * @param modeId Mode id, or null for a non-diatonic (custom) mask.
 * @returns The label string.
 */
export function keyLabel(rootPc: number, modeId: string | null): string {
  const root = PITCH_CLASS_NAMES[((rootPc % 12) + 12) % 12];
  const mode = KEY_MODE_CHOICES.find((c) => c.id === modeId);
  return `${root} ${mode ? mode.label : 'Custom scale'}`;
}
