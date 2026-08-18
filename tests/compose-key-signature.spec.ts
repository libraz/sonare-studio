/**
 * Proof that the MusicXML key-signature bridge hands libcantus the key the
 * signature actually denotes: the right spelled tonic, and a scale whose seven
 * letters carry exactly the accidentals the signature writes.
 */

import { spellScale } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { keyFifthsToSpelledKey, keyScaleToKeyFifths, tonicPcFromKeyFifths } from '@/compose/key';

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
const LETTER_PITCH_CLASSES = [0, 2, 4, 5, 7, 9, 11] as const;

/** Order in which a key signature adds sharps, then the order for flats. */
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'] as const;
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'] as const;

const ALL_FIFTHS: readonly number[] = [-7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7];

function format(note: { letter: number; alter: number }): string {
  const accidental =
    note.alter === 0 ? '' : note.alter > 0 ? '#'.repeat(note.alter) : 'b'.repeat(-note.alter);
  return `${LETTERS[note.letter]}${accidental}`;
}

/** The seven notes a signature writes, in letter order from C. */
function signatureScaleNames(fifths: number): string[] {
  const altered = new Set<string>(
    fifths >= 0 ? SHARP_ORDER.slice(0, fifths) : FLAT_ORDER.slice(0, -fifths),
  );
  return LETTERS.map((letter) => {
    if (!altered.has(letter)) return letter;
    return `${letter}${fifths > 0 ? '#' : 'b'}`;
  });
}

describe('keyFifthsToSpelledKey', () => {
  it('walks the circle of fifths for the major tonic', () => {
    const tonics = ALL_FIFTHS.map((fifths) => format(keyFifthsToSpelledKey(fifths).tonic));
    expect(tonics).toEqual([
      'Cb',
      'Gb',
      'Db',
      'Ab',
      'Eb',
      'Bb',
      'F',
      'C',
      'G',
      'D',
      'A',
      'E',
      'B',
      'F#',
      'C#',
    ]);
  });

  it('spells a tonic that sounds at the scale root', () => {
    for (const fifths of ALL_FIFTHS) {
      const { tonic, key } = keyFifthsToSpelledKey(fifths);
      const sounding = (((LETTER_PITCH_CLASSES[tonic.letter] + tonic.alter) % 12) + 12) % 12;
      expect(sounding).toBe(key.rootPc);
      expect(key.rootPc).toBe(tonicPcFromKeyFifths(fifths));
    }
  });

  it('produces a scale whose accidentals are the ones the signature writes', () => {
    for (const fifths of ALL_FIFTHS) {
      const { tonic, key } = keyFifthsToSpelledKey(fifths);
      const spelled = spellScale(tonic, key)
        .slice()
        .sort((a, b) => a.letter - b.letter)
        .map(format);
      expect(spelled).toEqual(signatureScaleNames(fifths));
    }
  });

  it('round-trips through keyScaleToKeyFifths, collapsing enharmonic signatures', () => {
    // keyScaleToKeyFifths reads a pitch class, which cannot tell Cb major from
    // B major, so it answers with the conventional spelling of that pitch
    // class: the tritone key comes back as six flats (Gb), not six sharps.
    const roundTripped = ALL_FIFTHS.map((fifths) =>
      keyScaleToKeyFifths(keyFifthsToSpelledKey(fifths).key),
    );
    expect(roundTripped).toEqual([5, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, -6, -5]);
  });
});
