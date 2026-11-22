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
 * The same conversion is what a detected key comes back through: a project that
 * never had a key set gets one estimated from its notes here, rather than every
 * theory surface reading against a silently assumed C major.
 *
 * Pure module (no Vue/Pinia); the store-reading helpers live in the callers.
 */

import {
  detectKeyFromNotes,
  type KeyScale,
  keySignatureFifths,
  MAJOR_MASK,
  type NoteData,
  type NoteEvent,
  spelledKeyOf,
} from '@libraz/libcantus';
import { pitchClassOf } from '@/lib/pitch';
import { MAJOR_MODE_MASK, type ScaleHighlightConfig } from '@/project/types';
import { harmonicTracksOnly, type TrackWithNotes } from './tracks';

/** Default key used when the project has no key set: C major. */
export const DEFAULT_KEY_SCALE: KeyScale = { rootPc: 0, modeMask12: MAJOR_MODE_MASK };

/**
 * Converts a store scale-highlight config to a libcantus key/scale.
 *
 * The `enabled` flag is a UI concern and is dropped; callers decide whether to
 * treat a disabled highlight as "no key" (falling back to {@link DEFAULT_KEY_SCALE}).
 */
export function scaleHighlightToKeyScale(config: ScaleHighlightConfig): KeyScale {
  return { rootPc: pitchClassOf(config.rootPc), modeMask12: config.modeMask };
}

/**
 * Converts a libcantus key/scale to a store scale-highlight config.
 *
 * @param key Key/scale to display.
 * @param enabled Whether highlighting should be active (default true).
 */
export function keyScaleToScaleHighlight(key: KeyScale, enabled = true): ScaleHighlightConfig {
  return { enabled, rootPc: pitchClassOf(key.rootPc), modeMask: key.modeMask12 };
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
 * How far the best-ranked key must outscore the best candidate on a different
 * tonic before the estimate is taken.
 *
 * libcantus ranks all 24 keys and always names a winner, so the top entry alone
 * says nothing about whether the music actually establishes a tonic: a
 * chromatic cluster or a whole-tone passage scores the same on every tonic and
 * the winner is decided by the tie-break. Requiring a margin over the best
 * rival tonic rejects exactly those, while leaving an ordinary tonal piece —
 * whose relative major/minor pair trails it by far more than this — detected.
 */
const KEY_DETECTION_MIN_TONIC_MARGIN = 0.02;

/**
 * Estimates the key of a set of notes, as a scale-highlight configuration.
 *
 * Callers must treat the result as a guess: it is derived from what the notes
 * emphasise (duration times velocity), not from anything the composer stated.
 *
 * @param notes Sounding notes, onsets and durations in quarter-note beats.
 * @returns The estimated key with highlighting on, or null when nothing sounds
 *   or no tonic stands out (see {@link KEY_DETECTION_MIN_TONIC_MARGIN}).
 */
export function detectScaleHighlight(notes: ReadonlyArray<NoteEvent>): ScaleHighlightConfig | null {
  let ranked: ReturnType<typeof detectKeyFromNotes>;
  try {
    ranked = detectKeyFromNotes(notes);
  } catch {
    // Malformed note events are an input problem, not something the editor
    // should surface as a key: it simply goes on without an estimate.
    return null;
  }
  const best = ranked[0];
  if (best === undefined || best.score <= 0) return null;
  const rival = ranked.find((match) => match.key.rootPc !== best.key.rootPc);
  if (rival !== undefined && best.score - rival.score < KEY_DETECTION_MIN_TONIC_MARGIN) return null;
  return keyScaleToScaleHighlight(best.key);
}

/**
 * Estimates the key of a project from its tracks' notes.
 *
 * Percussion tracks are dropped first (see {@link harmonicTracksOnly}), since a
 * drum kit's note numbers are instrument slots rather than pitches and would
 * weigh on the histogram as if they were.
 *
 * @param items Tracks paired with their notes; note positions must share one
 *   beat frame across the tracks.
 * @returns The estimated key, or null when there is nothing to estimate from.
 */
export function detectScaleHighlightFromTracks(
  items: ReadonlyArray<TrackWithNotes>,
): ScaleHighlightConfig | null {
  const { harmonic } = harmonicTracksOnly(items);
  const notes: NoteEvent[] = [];
  for (const item of harmonic) {
    for (const note of item.notes) {
      if (note.durationPpq <= 0) continue;
      notes.push({
        pitch: note.pitch,
        startBeat: note.startPpq,
        durationBeat: note.durationPpq,
        velocity: note.velocity,
      });
    }
  }
  return notes.length > 0 ? detectScaleHighlight(notes) : null;
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
    rootPc: pitchClassOf(key.rootPc),
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
  return pitchClassOf(keyFifths * 7);
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
