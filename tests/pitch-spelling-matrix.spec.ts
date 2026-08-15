/**
 * Full spelling matrix for the notation pipeline.
 *
 * Every pitch class at every MusicXML key signature is rendered as one compact
 * row per signature, so a change in the spelling engine shows up as a readable
 * row diff rather than a pile of individual assertions. The engraved MusicXML
 * output is derived directly from these spellings, so a diff here is a diff in
 * the score.
 */

import { isScaleTone, spellPitch } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { keyFifthsToSpelledKey } from '@/compose/key';
import {
  type PitchSpellingContext,
  type SpelledPitch,
  spellPitchInKeySignature,
  spellPitchWithContext,
} from '@/notation/pitch-spelling';

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;

/** Key signatures MusicXML can express, sharpest flat side first. */
const ALL_FIFTHS: readonly number[] = [-7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7];

/** Renders a spelled pitch as `Bb4`, `F##3`, `Cb5`. */
function format(pitch: SpelledPitch): string {
  const accidental =
    pitch.alter === 0 ? '' : pitch.alter > 0 ? '#'.repeat(pitch.alter) : 'b'.repeat(-pitch.alter);
  return `${pitch.step}${accidental}${pitch.octave}`;
}

/** One row per key signature: the twelve pitch classes of the octave above C4. */
function matrix(spell: (midi: number, fifths: number) => SpelledPitch): string[] {
  return ALL_FIFTHS.map((fifths) => {
    const tokens: string[] = [];
    for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) {
      tokens.push(format(spell(60 + pitchClass, fifths)));
    }
    return `${fifths} | ${tokens.join(' ')}`;
  });
}

function contextMatrix(context: (midi: number) => PitchSpellingContext): string[] {
  return matrix((midi, fifths) => spellPitchWithContext(midi, fifths, context(midi)));
}

describe('spelling matrix', () => {
  it('spells every pitch class at every key signature', () => {
    expect(matrix(spellPitchInKeySignature)).toEqual([
      '-7 | C4 Db4 D4 Eb4 Fb4 F4 Gb4 G4 Ab4 A4 Bb4 Cb5',
      '-6 | C4 Db4 D4 Eb4 E4 F4 Gb4 G4 Ab4 A4 Bb4 Cb5',
      '-5 | C4 Db4 D4 Eb4 E4 F4 Gb4 G4 Ab4 A4 Bb4 B4',
      '-4 | C4 Db4 D4 Eb4 E4 F4 Gb4 G4 Ab4 A4 Bb4 B4',
      '-3 | C4 Db4 D4 Eb4 E4 F4 Gb4 G4 Ab4 A4 Bb4 B4',
      '-2 | C4 Db4 D4 Eb4 E4 F4 Gb4 G4 Ab4 A4 Bb4 B4',
      '-1 | C4 Db4 D4 Eb4 E4 F4 Gb4 G4 Ab4 A4 Bb4 B4',
      '0 | C4 C#4 D4 D#4 E4 F4 F#4 G4 G#4 A4 A#4 B4',
      '1 | C4 C#4 D4 D#4 E4 F4 F#4 G4 G#4 A4 A#4 B4',
      '2 | C4 C#4 D4 D#4 E4 F4 F#4 G4 G#4 A4 A#4 B4',
      '3 | C4 C#4 D4 D#4 E4 F4 F#4 G4 G#4 A4 A#4 B4',
      '4 | C4 C#4 D4 D#4 E4 F4 F#4 G4 G#4 A4 A#4 B4',
      '5 | C4 C#4 D4 D#4 E4 F4 F#4 G4 G#4 A4 A#4 B4',
      '6 | C4 C#4 D4 D#4 E4 E#4 F#4 G4 G#4 A4 A#4 B4',
      '7 | B#3 C#4 D4 D#4 E4 E#4 F#4 G4 G#4 A4 A#4 B4',
    ]);
  });

  it('keeps the octave with the letter across the B#/Cb boundary', () => {
    // C# major's tonic is B# below middle C, not C4.
    expect(spellPitchInKeySignature(60, 7)).toEqual({ step: 'B', alter: 1, octave: 3 });
    expect(spellPitchInKeySignature(72, 7)).toEqual({ step: 'B', alter: 1, octave: 4 });
    // Cb major's tonic is Cb above B, not Cb in B's octave.
    expect(spellPitchInKeySignature(71, -7)).toEqual({ step: 'C', alter: -1, octave: 5 });
    expect(spellPitchInKeySignature(59, -7)).toEqual({ step: 'C', alter: -1, octave: 4 });
    // Fb and E# stay in their own octave.
    expect(spellPitchInKeySignature(64, -7)).toEqual({ step: 'F', alter: -1, octave: 4 });
    expect(spellPitchInKeySignature(65, 7)).toEqual({ step: 'E', alter: 1, octave: 4 });
  });

  it('spans the whole MIDI range', () => {
    expect(spellPitchInKeySignature(0, 0)).toEqual({ step: 'C', alter: 0, octave: -1 });
    expect(spellPitchInKeySignature(127, 0)).toEqual({ step: 'G', alter: 0, octave: 9 });
    expect(spellPitchInKeySignature(0, 7)).toEqual({ step: 'B', alter: 1, octave: -2 });
    expect(spellPitchInKeySignature(127, -7)).toEqual({ step: 'G', alter: 0, octave: 9 });
  });

  it('matches the theory engine on every diatonic tone of the MIDI range', () => {
    // The scale tones are spelled by libcantus, so letter, accidental and
    // octave must agree over the whole range, not only around middle C.
    for (const fifths of ALL_FIFTHS) {
      const { tonic, key } = keyFifthsToSpelledKey(fifths);
      for (let midi = 0; midi <= 127; midi += 1) {
        if (!isScaleTone(midi, key)) continue;
        const engine = spellPitch(midi, tonic, key);
        expect(format(spellPitchInKeySignature(midi, fifths))).toBe(
          format({
            step: LETTERS[engine.letter],
            alter: engine.alter as SpelledPitch['alter'],
            octave: engine.octave ?? Number.NaN,
          }),
        );
      }
    }
  });

  it('rejects MIDI numbers outside 0-127', () => {
    expect(() => spellPitchInKeySignature(-1, 0)).toThrow(RangeError);
    expect(() => spellPitchInKeySignature(128, 0)).toThrow(RangeError);
    expect(() => spellPitchInKeySignature(60.5, 0)).toThrow(RangeError);
    expect(() => spellPitchInKeySignature(Number.NaN, 0)).toThrow(RangeError);
  });
});

describe('contextual spelling matrix', () => {
  it('prefers upward resolution and double sharps when the line rises by a semitone', () => {
    expect(contextMatrix((midi) => ({ nextMidi: midi + 1 }))).toEqual([
      '-7 | C4 C#4 C##4 Eb4 D##4 F4 E##4 F##4 G#4 G##4 Bb4 A##4',
      '-6 | C4 C#4 C##4 D#4 E4 F4 E##4 F##4 G#4 G##4 Bb4 A##4',
      '-5 | C4 C#4 C##4 D#4 E4 F4 E##4 F##4 G#4 G##4 A#4 B4',
      '-4 | C4 C#4 C##4 D#4 E4 F4 E##4 F##4 G#4 G##4 A#4 B4',
      '-3 | C4 C#4 C##4 D#4 E4 F4 E##4 F##4 G#4 G##4 A#4 B4',
      '-2 | C4 C#4 C##4 D#4 E4 F4 E##4 F##4 G#4 G##4 A#4 B4',
      '-1 | C4 C#4 C##4 D#4 E4 F4 E##4 F##4 G#4 G##4 A#4 B4',
      '0 | C4 C#4 C##4 D#4 E4 F4 F#4 F##4 G#4 G##4 A#4 B4',
      '1 | C4 C#4 C##4 D#4 E4 F4 F#4 F##4 G#4 G##4 A#4 B4',
      '2 | C4 C#4 C##4 D#4 E4 F4 F#4 F##4 G#4 G##4 A#4 B4',
      '3 | C4 C#4 C##4 D#4 E4 F4 F#4 F##4 G#4 G##4 A#4 B4',
      '4 | C4 C#4 C##4 D#4 E4 F4 F#4 F##4 G#4 G##4 A#4 B4',
      '5 | C4 C#4 C##4 D#4 E4 F4 F#4 F##4 G#4 G##4 A#4 B4',
      '6 | C4 C#4 C##4 D#4 D##4 E#4 F#4 F##4 G#4 G##4 A#4 B4',
      '7 | B#3 C#4 C##4 D#4 D##4 E#4 F#4 F##4 G#4 G##4 A#4 A##4',
    ]);
  });

  it('spells chord tones by their interval above the chord root', () => {
    expect(contextMatrix(() => ({ chordRootMidi: 60 }))).toEqual([
      '-7 | C4 Db4 D4 Eb4 E4 F4 F#4 G4 Ab4 A4 Bb4 B4',
      '-6 | C4 Db4 D4 Eb4 E4 F4 F#4 G4 Ab4 A4 Bb4 B4',
      '-5 | C4 Db4 D4 Eb4 E4 F4 F#4 G4 Ab4 A4 Bb4 B4',
      '-4 | C4 Db4 D4 Eb4 E4 F4 F#4 G4 Ab4 A4 Bb4 B4',
      '-3 | C4 Db4 D4 Eb4 E4 F4 F#4 G4 Ab4 A4 Bb4 B4',
      '-2 | C4 Db4 D4 Eb4 E4 F4 F#4 G4 Ab4 A4 Bb4 B4',
      '-1 | C4 Db4 D4 Eb4 E4 F4 F#4 G4 Ab4 A4 Bb4 B4',
      '0 | C4 Db4 D4 Eb4 E4 F4 F#4 G4 Ab4 A4 Bb4 B4',
      '1 | C4 Db4 D4 Eb4 E4 F4 F#4 G4 Ab4 A4 Bb4 B4',
      '2 | C4 Db4 D4 Eb4 E4 F4 F#4 G4 Ab4 A4 Bb4 B4',
      '3 | C4 Db4 D4 Eb4 E4 F4 F#4 G4 Ab4 A4 Bb4 B4',
      '4 | C4 Db4 D4 Eb4 E4 F4 F#4 G4 Ab4 A4 Bb4 B4',
      '5 | C4 Db4 D4 Eb4 E4 F4 F#4 G4 Ab4 A4 Bb4 B4',
      '6 | C4 Db4 D4 Eb4 E4 F4 F#4 G4 Ab4 A4 Bb4 B4',
      '7 | B#3 C#4 C##4 D#4 D##4 E#4 E##4 F##4 G#4 G##4 A#4 A##4',
    ]);
  });
});
