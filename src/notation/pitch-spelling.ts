/**
 * Pitch spelling for the display-only notation pipeline.
 *
 * Converts MIDI note numbers to MusicXML-style spelled pitches
 * (step/alter/octave) using the key signature to choose between sharp and
 * flat spellings, and converts between MusicXML key fifths and libsonare
 * key descriptions.
 */

import type { Key, Mode } from '@/wasm/index.js';

/** Diatonic step letter (MusicXML `<step>`). */
export type Step = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

/** A spelled pitch following MusicXML conventions (C4 = MIDI 60). */
export interface SpelledPitch {
  /** Step letter A-G. */
  step: Step;
  /** Chromatic alteration: -1 = flat, 0 = natural, 1 = sharp. */
  alter: -1 | 0 | 1;
  /** Scientific octave number (MusicXML `<octave>`; C4 = MIDI 60). */
  octave: number;
}

/** Sharp-side spelling for each pitch class (C = 0). */
const SHARP_SPELLINGS: ReadonlyArray<Readonly<Pick<SpelledPitch, 'step' | 'alter'>>> = [
  { step: 'C', alter: 0 },
  { step: 'C', alter: 1 },
  { step: 'D', alter: 0 },
  { step: 'D', alter: 1 },
  { step: 'E', alter: 0 },
  { step: 'F', alter: 0 },
  { step: 'F', alter: 1 },
  { step: 'G', alter: 0 },
  { step: 'G', alter: 1 },
  { step: 'A', alter: 0 },
  { step: 'A', alter: 1 },
  { step: 'B', alter: 0 },
];

/** Flat-side spelling for each pitch class (C = 0). */
const FLAT_SPELLINGS: ReadonlyArray<Readonly<Pick<SpelledPitch, 'step' | 'alter'>>> = [
  { step: 'C', alter: 0 },
  { step: 'D', alter: -1 },
  { step: 'D', alter: 0 },
  { step: 'E', alter: -1 },
  { step: 'E', alter: 0 },
  { step: 'F', alter: 0 },
  { step: 'G', alter: -1 },
  { step: 'G', alter: 0 },
  { step: 'A', alter: -1 },
  { step: 'A', alter: 0 },
  { step: 'B', alter: -1 },
  { step: 'B', alter: 0 },
];

/**
 * Spells a MIDI pitch as step/alter/octave for a given key signature.
 *
 * Naturals are always spelled plain; black keys are spelled as sharps in
 * sharp keys (and in C major / A minor) and as flats in flat keys. The
 * octave follows MusicXML scientific pitch notation (MIDI 60 = C4); the
 * spellings used here never cross an octave boundary (no B#/Cb), so the
 * octave is always `floor(midi / 12) - 1`.
 *
 * @param midi MIDI note number (integer 0-127).
 * @param keyFifths Key signature as MusicXML fifths (-7..7; >= 0 spells sharps).
 * @returns The spelled pitch.
 * @throws RangeError If `midi` is not an integer in 0-127.
 */
export function spellPitch(midi: number, keyFifths: number): SpelledPitch {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
    throw new RangeError(`spellPitch: midi must be an integer in 0-127, got ${midi}`);
  }
  const table = keyFifths < 0 ? FLAT_SPELLINGS : SHARP_SPELLINGS;
  const { step, alter } = table[midi % 12];
  return { step, alter, octave: Math.floor(midi / 12) - 1 };
}

/**
 * Key-fifths offset of each libsonare `Mode` relative to the major key with
 * the same tonic (index = audio `Mode` ordinal: Major, Minor, Dorian,
 * Phrygian, Lydian, Mixolydian, Locrian).
 */
const MODE_FIFTHS_OFFSET: ReadonlyArray<number> = [0, -3, -2, -4, 1, -1, -5];

/**
 * Normalizes a fifths count to the canonical range -5..6 (enharmonic keys
 * outside the range collapse, e.g. Cb major -7 -> B major 5).
 */
function normalizeFifths(fifths: number): number {
  const mod = ((fifths % 12) + 12) % 12;
  return mod > 6 ? mod - 12 : mod;
}

/**
 * Computes the MusicXML key fifths for a libsonare key (tonic + mode).
 *
 * The tonic pitch class alone cannot distinguish enharmonic key spellings,
 * so the result is normalized to -5..6 (e.g. tonic pc 6 major -> 6 = F#
 * major, never -6 = Gb major).
 *
 * @param key Tonic pitch class and mode (libsonare audio `Mode` ordinals,
 *   Major = 0; not the +1-shifted `ProjectKeySegment.mode` encoding).
 * @returns Key signature fifths in -5..6.
 */
export function keyToKeyFifths(key: Pick<Key, 'root' | 'mode'>): number {
  // 7 is the multiplicative inverse of 7 mod 12, so pc * 7 mod 12 inverts
  // "fifths -> tonic pc" for major; the mode offset shifts to the major
  // key sharing the same signature.
  return normalizeFifths(((key.root * 7) % 12) + MODE_FIFTHS_OFFSET[key.mode]);
}

/**
 * Computes the libsonare key (tonic + mode) for a key signature.
 *
 * @param keyFifths Key signature fifths (-7..7).
 * @param mode Audio `Mode` ordinal the signature should be read in
 *   (defaults to Major = 0).
 * @returns Tonic pitch class and mode; e.g. (0, Minor) -> A minor.
 */
export function keyFifthsToKey(keyFifths: number, mode: Mode = 0): Pick<Key, 'root' | 'mode'> {
  const majorFifths = keyFifths - MODE_FIFTHS_OFFSET[mode];
  const root = (((majorFifths * 7) % 12) + 12) % 12;
  return { root: root as Key['root'], mode };
}

/**
 * Converts an audio `Mode` ordinal (Major = 0) to the `ProjectKeySegment.mode`
 * encoding (0 = unknown, 1 = major, 2 = minor, ...).
 *
 * @param mode Audio `Mode` ordinal.
 * @returns The +1-shifted project annotation ordinal.
 */
export function modeToProjectMode(mode: Mode): number {
  return mode + 1;
}

/**
 * Converts a `ProjectKeySegment.mode` ordinal (0 = unknown, 1 = major, ...)
 * back to the audio `Mode` enum.
 *
 * @param projectMode Project annotation mode ordinal.
 * @returns The audio `Mode` ordinal, or undefined for unknown (0) or
 *   out-of-range values.
 */
export function projectModeToMode(projectMode: number): Mode | undefined {
  if (!Number.isInteger(projectMode) || projectMode < 1 || projectMode > 7) {
    return undefined;
  }
  return (projectMode - 1) as Mode;
}
