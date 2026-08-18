/**
 * Key / mode helpers for the key editor, built on the 12-bit interval masks
 * the scale-highlight configuration uses (bit n = interval n semitones above
 * the root is in the scale). Pure module (no DOM, no framework imports).
 */

import { type NoteNameSystem, namedScaleMask, type ScaleName } from '@libraz/libcantus';
import { keyScaleToKeyFifths, scaleHighlightToKeyScale } from '@/compose/key';
import { PITCH_CLASS_NAMES, pitchClassNames } from '@/lib/pitch';
import type { ScaleHighlightConfig } from '@/project/types';

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

/** One selectable mode: the editor's id paired with the scale it names. */
export interface KeyModeChoice {
  /** Stable identifier used as the select value. */
  id: KeyModeId;
  /** The scale itself, addressed by its name in the shared scale vocabulary. */
  scale: ScaleName;
}

/**
 * The modes the key editor offers, in display order.
 *
 * Each is a name into the shared scale vocabulary rather than a mask written
 * out here, so the editor, the score and the sample editor's tuner all read one
 * definition of what "dorian" is.
 */
export const KEY_MODE_CHOICES: ReadonlyArray<KeyModeChoice> = [
  { id: 'major', scale: 'major' },
  { id: 'dorian', scale: 'dorian' },
  { id: 'phrygian', scale: 'phrygian' },
  { id: 'lydian', scale: 'lydian' },
  { id: 'mixolydian', scale: 'mixolydian' },
  { id: 'minor', scale: 'naturalMinor' },
  { id: 'harmonicMinor', scale: 'harmonicMinor' },
  { id: 'melodicMinor', scale: 'melodicMinor' },
  { id: 'locrian', scale: 'locrian' },
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
 * Returns the interval mask of a mode.
 *
 * @param id One of the {@link KEY_MODE_CHOICES} ids.
 * @returns The mode's 12-bit interval mask.
 */
export function modeMaskForChoice(id: string): number {
  const choice = KEY_MODE_CHOICES.find((c) => c.id === id);
  if (!choice) throw new RangeError(`Unknown key mode: ${id}`);
  const mask = namedScaleMask(choice.scale);
  if (mask === undefined) throw new RangeError(`Unknown scale: ${choice.scale}`);
  return mask;
}

/**
 * Finds the offered mode matching an interval mask.
 *
 * @param mask 12-bit interval mask.
 * @returns The matching mode id, or null for a mask no offered mode has.
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
 * Converts a configured scale to the MusicXML key-signature fifths used by
 * score and chord-symbol spelling. Switching highlighting off says there is no
 * key to sign, which keeps the neutral C-major spelling; any scale that is on
 * signs from its own tonic, harmonic and melodic minor included.
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
