/**
 * Key/scale bridge between the store's {@link ScaleHighlightConfig} and
 * libcantus's {@link KeyScale}.
 *
 * Both sides encode a scale as a root pitch class plus a 12-bit interval mask
 * where bit `n` marks the pitch class `(root + n) % 12` as in-scale (bit 0, the
 * root, always set). The conventions are identical — libcantus's `MAJOR_MASK`
 * equals the app's `MAJOR_MODE_MASK` (both 2741) — so the conversion is a plain
 * field rename. {@link assertMaskConventionParity} pins that equality so a
 * future drift on either side is caught by the adapter unit test rather than
 * silently mis-highlighting scales.
 *
 * Pure module (no Vue/Pinia); the store-reading helpers live in the callers.
 */

import {
  type KeyScale,
  keySignatureFifths,
  MAJOR_MASK,
  type NoteData,
  spelledKeyOf,
} from '@libraz/libcantus';
import { MAJOR_MODE_MASK, type ScaleHighlightConfig } from '@/project/types';

/** Default key used when the project has no key set: C major. */
export const DEFAULT_KEY_SCALE: KeyScale = { rootPc: 0, modeMask12: MAJOR_MODE_MASK };

/**
 * Converts a store scale-highlight config to a libcantus key/scale.
 *
 * The `enabled` flag is a UI concern and is dropped; callers decide whether to
 * treat a disabled highlight as "no key" (falling back to {@link DEFAULT_KEY_SCALE}).
 */
export function scaleHighlightToKeyScale(config: ScaleHighlightConfig): KeyScale {
  return { rootPc: ((config.rootPc % 12) + 12) % 12, modeMask12: config.modeMask };
}

/**
 * Converts a libcantus key/scale to a store scale-highlight config.
 *
 * @param key Key/scale to display.
 * @param enabled Whether highlighting should be active (default true).
 */
export function keyScaleToScaleHighlight(key: KeyScale, enabled = true): ScaleHighlightConfig {
  return { enabled, rootPc: ((key.rootPc % 12) + 12) % 12, modeMask: key.modeMask12 };
}

/**
 * Resolves the key context for theory queries: the highlighted scale when
 * highlighting is enabled, otherwise the C-major default. Callers surface the
 * "no key set" state separately (see the guidance/card fallbacks).
 */
export function effectiveKeyScale(config: ScaleHighlightConfig): KeyScale {
  return config.enabled ? scaleHighlightToKeyScale(config) : DEFAULT_KEY_SCALE;
}

/**
 * Derives MusicXML key-signature fifths from a libcantus {@link KeyScale}.
 *
 * The scale is spelled first ({@link spelledKeyOf} names the conventional
 * tonic), and the signature is counted off that spelling. Every 12-bit mask is
 * answered, so a scale that has a conventional signature gets it: C harmonic
 * minor signs as three flats and writes its raised seventh as an accidental,
 * which is how it is written. A mask with no convention behind it still gets
 * the signature its tonic implies, which is a better ground for the accidentals
 * around it than C major would be.
 */
export function keyScaleToKeyFifths(key: KeyScale): number {
  const normalized: KeyScale = {
    rootPc: ((key.rootPc % 12) + 12) % 12,
    modeMask12: key.modeMask12,
  };
  return keySignatureFifths(spelledKeyOf(normalized).tonic, normalized);
}

/**
 * Major-key tonic pitch class for a key-signature fifths count (circle of
 * fifths): 0 = C, +1 = G, -1 = F, .... Used to give libcantus's spelling
 * functions a tonic derived from the score's `keyFifths`.
 */
export function tonicPcFromKeyFifths(keyFifths: number): number {
  return (((keyFifths * 7) % 12) + 12) % 12;
}

/** A key signature expressed the way libcantus's spelling functions take it. */
export interface SpelledKeySignature {
  /** Spelled tonic anchoring the letters (libcantus letter 0..6 = C..B). */
  tonic: NoteData;
  /** The scale those letters belong to. */
  key: KeyScale;
}

/**
 * Letter of the major tonic for a fifths count, walking the circle of fifths
 * (C G D A E B F...). Four letters up per fifth, modulo the seven letters.
 */
function tonicLetterFromKeyFifths(keyFifths: number): number {
  return (((keyFifths * 4) % 7) + 7) % 7;
}

/**
 * Converts MusicXML key-signature fifths to a spelled tonic and scale for
 * libcantus.
 *
 * A key signature fixes seven diatonic letters and nothing else: a major key
 * and its relative natural minor share both the signature and the pitch-class
 * set. The major reading is therefore always sufficient, and it is the only
 * one derivable from `fifths` alone. Each further sharp moves the tonic four
 * letters up the alphabet, and every seventh step adds an accidental, so the
 * spelling extends past the -7..7 MusicXML range (fifths 13 = F## major)
 * without a lookup table.
 *
 * @param keyFifths Key signature as MusicXML fifths (-7..7 in practice).
 * @returns The major tonic spelling and its scale.
 */
export function keyFifthsToSpelledKey(keyFifths: number): SpelledKeySignature {
  return {
    tonic: {
      letter: tonicLetterFromKeyFifths(keyFifths),
      alter: Math.floor((keyFifths + 1) / 7),
    },
    key: { rootPc: tonicPcFromKeyFifths(keyFifths), modeMask12: MAJOR_MASK },
  };
}

/**
 * Asserts that the app and libcantus agree on the major-scale interval mask.
 * Returns true on match; throws (in tests) when the two constants drift.
 */
export function assertMaskConventionParity(): boolean {
  if (MAJOR_MODE_MASK !== MAJOR_MASK) {
    throw new Error(
      `Scale-mask convention drift: MAJOR_MODE_MASK=${MAJOR_MODE_MASK} but libcantus MAJOR_MASK=${MAJOR_MASK}`,
    );
  }
  return true;
}
