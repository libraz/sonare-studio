/**
 * Key / mode helpers for the key editor, built on the 12-bit interval masks
 * the scale-highlight configuration uses (bit n = interval n semitones above
 * the root is in the scale). Pure module (no DOM, no framework imports).
 */

import type { NoteNameSystem } from '@libraz/libcantus';
import { keyScaleToKeyFifths, scaleHighlightToKeyScale } from '@/compose/key';
import { PITCH_CLASS_NAMES, pitchClassNames } from '@/lib/pitch';
import type { ScaleHighlightConfig } from '@/project/types';
import { MAJOR_MODE_MASK } from '@/project/types';

export { keyScaleToKeyFifths } from '@/compose/key';
export { PITCH_CLASS_NAMES };

export type KeyModeId =
  | 'major'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'minor'
  | 'harmonicMinor'
  | 'melodicMinor'
  | 'locrian';

/** One selectable diatonic mode. */
export interface KeyModeChoice {
  /** Stable identifier used as the select value. */
  id: KeyModeId;
  /** Semitone offset of the mode's tonic above the major-scale tonic. */
  semitoneOffset: number;
  /** Explicit interval mask for modes not derived by major-scale rotation. */
  modeMask?: number;
}

/** The seven diatonic modes, each derived from the major mask by rotation. */
export const KEY_MODE_CHOICES: ReadonlyArray<KeyModeChoice> = [
  { id: 'major', semitoneOffset: 0 },
  { id: 'dorian', semitoneOffset: 2 },
  { id: 'phrygian', semitoneOffset: 4 },
  { id: 'lydian', semitoneOffset: 5 },
  { id: 'mixolydian', semitoneOffset: 7 },
  { id: 'minor', semitoneOffset: 9 },
  { id: 'harmonicMinor', semitoneOffset: 9, modeMask: 0b100110101101 },
  { id: 'melodicMinor', semitoneOffset: 9, modeMask: 0b101010101101 },
  { id: 'locrian', semitoneOffset: 11 },
];

/** libsonare `Mode` ordinal by UI mode id. */
const MODE_ORDINAL_BY_ID: Readonly<Record<KeyModeId, number>> = {
  major: 0,
  minor: 1,
  dorian: 2,
  phrygian: 3,
  lydian: 4,
  mixolydian: 5,
  locrian: 6,
  // These share the natural-minor key signature for score spelling.
  harmonicMinor: 1,
  melodicMinor: 1,
};

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
  return choice.modeMask ?? rotateModeMask(MAJOR_MODE_MASK, choice.semitoneOffset);
}

/**
 * Finds the diatonic mode matching an interval mask.
 *
 * @param mask 12-bit interval mask.
 * @returns The matching mode id, or null for non-diatonic masks.
 */
export function matchModeChoiceId(mask: number): string | null {
  for (const choice of KEY_MODE_CHOICES) {
    if (modeMaskForChoice(choice.id) === mask) return choice.id;
  }
  return null;
}

/**
 * Converts a mode choice id to the libsonare `Mode` ordinal.
 *
 * @param id One of the {@link KEY_MODE_CHOICES} ids.
 * @returns Mode ordinal (Major = 0, Minor = 1, Dorian = 2, ...).
 */
export function modeOrdinalForChoice(id: string): number {
  const ordinal = MODE_ORDINAL_BY_ID[id as KeyModeId];
  if (ordinal === undefined) throw new RangeError(`Unknown key mode: ${id}`);
  return ordinal;
}

/**
 * Converts a configured diatonic scale to the MusicXML key-signature fifths
 * used by score and chord-symbol spelling. Disabled or custom scales have no
 * unambiguous signature, so they retain the neutral C-major spelling.
 */
export function keyFifthsForScaleHighlight(config: ScaleHighlightConfig): number {
  if (!config.enabled) return 0;
  return keyScaleToKeyFifths(scaleHighlightToKeyScale(config));
}

/**
 * Builds a display label such as "C Major (Ionian)" or "A Minor (Aeolian)".
 *
 * The mode word stays in the UI language while the tonic follows the
 * note-name system, since the two are separate preferences.
 *
 * @param rootPc Root pitch class (0-11, C = 0).
 * @param modeId Mode id, or null for a non-diatonic (custom) mask.
 * @param labels Localized mode names and the custom-scale fallback.
 * @param system Note-name system for the tonic; English by default.
 * @returns The label string.
 */
export function keyLabel(
  rootPc: number,
  modeId: string | null,
  labels: Readonly<{ modes: Readonly<Record<string, string>>; customScale: string }>,
  system: NoteNameSystem = 'english',
): string {
  const root = pitchClassNames(system)[((rootPc % 12) + 12) % 12];
  const mode = KEY_MODE_CHOICES.find((c) => c.id === modeId);
  return `${root} ${mode ? (labels.modes[mode.id] ?? mode.id) : labels.customScale}`;
}
