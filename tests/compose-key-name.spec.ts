import { describe, expect, it } from 'vitest';
import {
  KEY_MARKER_PREFIX,
  keyMarkerName,
  keyName,
  keySignatureFromMarker,
  keySignatureFromName,
} from '@/compose/key-name';

/**
 * Key-signature marker text is a persisted wire format shared by the SMF and
 * MusicXML paths and by the score toolbar, so what these pin is the text itself
 * and its round trip — not how the tonic of a signature is worked out, which is
 * the shared theory vocabulary's answer to give.
 */

const ALL_FIFTHS = Array.from({ length: 15 }, (_, index) => index - 7);

describe('keyName', () => {
  it('names the major key of every signature', () => {
    expect(ALL_FIFTHS.map((fifths) => keyName(fifths, false))).toEqual([
      'Cb major',
      'Gb major',
      'Db major',
      'Ab major',
      'Eb major',
      'Bb major',
      'F major',
      'C major',
      'G major',
      'D major',
      'A major',
      'E major',
      'B major',
      'F# major',
      'C# major',
    ]);
  });

  it('names the minor key of every signature', () => {
    expect(ALL_FIFTHS.map((fifths) => keyName(fifths, true))).toEqual([
      'Ab minor',
      'Eb minor',
      'Bb minor',
      'F minor',
      'C minor',
      'G minor',
      'D minor',
      'A minor',
      'E minor',
      'B minor',
      'F# minor',
      'C# minor',
      'G# minor',
      'D# minor',
      'A# minor',
    ]);
  });

  // A malformed file must still round-trip as a key rather than throwing.
  it('falls back to C for a signature no key is written for', () => {
    expect(keyName(99, false)).toBe('C major');
    expect(keyName(Number.NaN, true)).toBe('C minor');
  });
});

describe('keySignatureFromName', () => {
  it('round-trips every signature in both modes', () => {
    for (const fifths of ALL_FIFTHS) {
      for (const minor of [false, true]) {
        expect(keySignatureFromName(keyName(fifths, minor))).toEqual({ fifths, minor });
      }
    }
  });

  /**
   * D-flat minor would take eight flats, so no signature is written for it. The
   * key editor still permits the name, and dropping it would lose a key change,
   * so it reads back as the signature that sounds the same.
   */
  it('reads a key whose name needs more accidentals than a signature has', () => {
    expect(keySignatureFromName('Db minor')).toEqual({ fifths: 4, minor: true });
    expect(keyName(4, true)).toBe('C# minor');
  });

  it('tolerates surrounding space and rejects text that is not a key', () => {
    expect(keySignatureFromName('  Eb major ')).toEqual({ fifths: -3, minor: false });
    expect(keySignatureFromName('Chorus')).toBeNull();
    expect(keySignatureFromName('')).toBeNull();
  });
});

describe('keyMarkerName / keySignatureFromMarker', () => {
  it('writes and reads the marker text the project stores', () => {
    expect(keyMarkerName(-3, false)).toBe(`${KEY_MARKER_PREFIX}Eb major`);
    expect(keySignatureFromMarker('Key: Eb major')).toEqual({ fifths: -3, minor: false });
  });

  it('ignores a marker that carries something other than a key', () => {
    expect(keySignatureFromMarker('Text: Eb major')).toBeNull();
    expect(keySignatureFromMarker('Eb major')).toBeNull();
  });
});
