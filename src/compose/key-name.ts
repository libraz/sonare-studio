/**
 * Key names on the wire: the one place the editor turns a key signature into
 * text and back.
 *
 * A key signature reaches the project as a `<fifths>` count plus a major/minor
 * flag (MusicXML, SMF), and is carried between subsystems as an SMF marker
 * named `"Key: C major"`. That marker text is a persisted wire format, so the
 * `Key: ` prefix and the `"<tonic> <mode>"` body are fixed here; what the tonic
 * of a given signature is, and how a written tonic reads back, are answered by
 * the shared theory vocabulary rather than by a table copied per caller.
 *
 * Pure module (no Vue/Pinia).
 */

import { formatKeyName, keyFromFifths, noteToPitchClass, tryParseKeyName } from '@libraz/libcantus';

/** Signatures a key name can be written for: seven flats through seven sharps. */
const SIGNATURE_FIFTHS: ReadonlyArray<number> = Array.from({ length: 15 }, (_, i) => i - 7);

/** Prefix identifying a key-signature marker in the SMF marker model. */
export const KEY_MARKER_PREFIX = 'Key: ';

/** A key signature as the import/export formats state it. */
export interface KeySignatureName {
  /** Signed sharps (positive) or flats (negative). */
  fifths: number;
  /** True for the minor reading of that signature. */
  minor: boolean;
}

/**
 * The conventional name of a key signature, e.g. `"Eb major"`, `"C# minor"`.
 *
 * @param fifths Signed sharps (positive) or flats (negative).
 * @param minor True for the minor reading.
 * @returns The `"<tonic> <mode>"` name; `"C major"` for a signature outside the
 *   range a name exists for, so a malformed file still round-trips as a key.
 */
export function keyName(fifths: number, minor: boolean): string {
  const mode = minor ? 'minor' : 'major';
  try {
    return formatKeyName({ tonic: keyFromFifths(fifths, mode).tonic, mode });
  } catch {
    return `C ${mode}`;
  }
}

/** The marker text carrying a key signature, e.g. `"Key: Eb major"`. */
export function keyMarkerName(fifths: number, minor: boolean): string {
  return `${KEY_MARKER_PREFIX}${keyName(fifths, minor)}`;
}

/**
 * Reads a key name back to its signature, or null when the text is not one.
 *
 * The name is matched on its spelling first, and on the tonic's pitch class
 * only if no signature spells it that way. That second pass is what keeps a key
 * whose name needs more than seven accidentals readable: D-flat minor would
 * take eight flats, so no signature is written for it, and it comes back as the
 * C-sharp minor signature rather than being dropped as unreadable.
 *
 * @param text A `"<tonic> <mode>"` name, with or without surrounding space.
 */
export function keySignatureFromName(text: string): KeySignatureName | null {
  const parsed = tryParseKeyName(text.trim());
  if (!parsed.ok) return null;
  const minor = parsed.value.mode === 'minor';
  const spelled = formatKeyName(parsed.value);
  const exact = SIGNATURE_FIFTHS.find((fifths) => keyName(fifths, minor) === spelled);
  if (exact !== undefined) return { fifths: exact, minor };
  const wanted = noteToPitchClass(parsed.value.tonic);
  const enharmonic = SIGNATURE_FIFTHS.find(
    (fifths) => noteToPitchClass(keyFromFifths(fifths, parsed.value.mode).tonic) === wanted,
  );
  return enharmonic === undefined ? null : { fifths: enharmonic, minor };
}

/**
 * Reads a key-signature marker's text, or null when the marker is not one.
 *
 * @param name Full marker text, including the `Key: ` prefix.
 */
export function keySignatureFromMarker(name: string): KeySignatureName | null {
  if (!name.startsWith(KEY_MARKER_PREFIX)) return null;
  return keySignatureFromName(name.slice(KEY_MARKER_PREFIX.length));
}
