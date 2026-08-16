import { describe, expect, it } from 'vitest';
import {
  keyFifthsToKey,
  keyToKeyFifths,
  modeToProjectMode,
  projectModeToMode,
  spellLineInKeySignature,
  spellPitchInKeySignature,
  spellPitchWithContext,
} from '@/notation/pitch-spelling';

describe('spellPitchInKeySignature', () => {
  it('spells naturals identically in every key', () => {
    for (const fifths of [-5, -1, 0, 1, 5]) {
      expect(spellPitchInKeySignature(60, fifths)).toEqual({ step: 'C', alter: 0, octave: 4 });
      expect(spellPitchInKeySignature(65, fifths)).toEqual({ step: 'F', alter: 0, octave: 4 });
      expect(spellPitchInKeySignature(71, fifths)).toEqual({ step: 'B', alter: 0, octave: 4 });
    }
  });

  it('spells black keys as sharps in C major (fifths = 0)', () => {
    expect(spellPitchInKeySignature(61, 0)).toEqual({ step: 'C', alter: 1, octave: 4 });
    expect(spellPitchInKeySignature(63, 0)).toEqual({ step: 'D', alter: 1, octave: 4 });
    expect(spellPitchInKeySignature(66, 0)).toEqual({ step: 'F', alter: 1, octave: 4 });
    expect(spellPitchInKeySignature(68, 0)).toEqual({ step: 'G', alter: 1, octave: 4 });
    expect(spellPitchInKeySignature(70, 0)).toEqual({ step: 'A', alter: 1, octave: 4 });
  });

  it('spells black keys as sharps in G major (fifths = 1)', () => {
    expect(spellPitchInKeySignature(66, 1)).toEqual({ step: 'F', alter: 1, octave: 4 });
    expect(spellPitchInKeySignature(61, 1)).toEqual({ step: 'C', alter: 1, octave: 4 });
  });

  it('spells black keys as flats in F major (fifths = -1)', () => {
    expect(spellPitchInKeySignature(70, -1)).toEqual({ step: 'B', alter: -1, octave: 4 });
    expect(spellPitchInKeySignature(63, -1)).toEqual({ step: 'E', alter: -1, octave: 4 });
  });

  it('spells black keys as flats in Db major (fifths = -5)', () => {
    expect(spellPitchInKeySignature(61, -5)).toEqual({ step: 'D', alter: -1, octave: 4 });
    expect(spellPitchInKeySignature(66, -5)).toEqual({ step: 'G', alter: -1, octave: 4 });
    expect(spellPitchInKeySignature(68, -5)).toEqual({ step: 'A', alter: -1, octave: 4 });
    expect(spellPitchInKeySignature(70, -5)).toEqual({ step: 'B', alter: -1, octave: 4 });
  });

  it('uses signature spellings across E#/Cb octave boundaries', () => {
    // F# major's leading tone is E#, not F natural.
    expect(spellPitchInKeySignature(65, 6)).toEqual({ step: 'E', alter: 1, octave: 4 });
    // Gb major's fourth degree is Cb; Cb4 is MIDI 59 rather than Cb3.
    expect(spellPitchInKeySignature(59, -6)).toEqual({ step: 'C', alter: -1, octave: 4 });
  });

  it('uses melodic and harmonic context for chromatic spellings', () => {
    // D minor: C# rises to D as the raised leading tone, rather than Db.
    expect(spellPitchWithContext(61, -1, { nextMidi: 62 })).toMatchObject({
      step: 'C',
      alter: 1,
    });
    expect(spellPitchWithContext(61, -1, { previousMidi: 62 })).toMatchObject({
      step: 'C',
      alter: 1,
    });
    // F major: D7 is D–F#–A–C, not D–Gb–A–C.
    expect(spellPitchWithContext(66, -1, { chordRootMidi: 62 })).toMatchObject({
      step: 'F',
      alter: 1,
    });
    // G major's borrowed bVI is Eb, not D#.
    expect(spellPitchWithContext(63, 1, { chordRootMidi: 63 })).toMatchObject({
      step: 'E',
      alter: -1,
    });
  });

  it('reads only a written second as melodic context, so a leap keeps its letter', () => {
    // The D of a D–F#–A–G phrase is a plain D. A leap up to F# says nothing
    // about how the note it leaves should be written, and reading it as a
    // resolution is what spelled this D as C## and this F# as E##.
    expect(spellPitchWithContext(62, 0, { nextMidi: 66 })).toMatchObject({ step: 'D', alter: 0 });
    expect(spellPitchWithContext(66, 0, { previousMidi: 62, nextMidi: 69 })).toMatchObject({
      step: 'F',
      alter: 1,
    });
    // Nor does a leap downwards make a double flat out of the A above it.
    expect(spellPitchWithContext(57, 0, { previousMidi: 60 })).toMatchObject({
      step: 'A',
      alter: 0,
    });
    // A whole step still counts: Bb steps up to C, where A# would be a
    // diminished third.
    expect(spellPitchWithContext(70, 0, { nextMidi: 72 })).toMatchObject({ step: 'B', alter: -1 });
  });

  it('uses MusicXML octaves (C4 = MIDI 60)', () => {
    expect(spellPitchInKeySignature(59, 0).octave).toBe(3);
    expect(spellPitchInKeySignature(60, 0).octave).toBe(4);
    expect(spellPitchInKeySignature(72, 0).octave).toBe(5);
    expect(spellPitchInKeySignature(0, 0)).toEqual({ step: 'C', alter: 0, octave: -1 });
    expect(spellPitchInKeySignature(127, 0)).toEqual({ step: 'G', alter: 0, octave: 9 });
  });

  it('rejects out-of-range MIDI numbers', () => {
    expect(() => spellPitchInKeySignature(-1, 0)).toThrow(RangeError);
    expect(() => spellPitchInKeySignature(128, 0)).toThrow(RangeError);
    expect(() => spellPitchInKeySignature(60.5, 0)).toThrow(RangeError);
  });
});

/** Renders a spelled line as `C4 Db4 ...` for readable assertions. */
function spellLineText(midis: readonly number[], keyFifths: number): string {
  return spellLineInKeySignature(
    midis.map((midi, index) => ({ midi, startBeat: index, durationBeat: 1 })),
    keyFifths,
  )
    .map((pitch) => {
      const accidental =
        pitch.alter === 0
          ? ''
          : pitch.alter > 0
            ? '#'.repeat(pitch.alter)
            : 'b'.repeat(-pitch.alter);
      return `${pitch.step}${accidental}${pitch.octave}`;
    })
    .join(' ');
}

describe('spellLineInKeySignature', () => {
  it('writes a phrase built on a secondary dominant with its own letters', () => {
    // D–F#–A over a G in C major is the dominant of the dominant. Every one of
    // its tones is a plain letter of the key, so nothing here needs an
    // accidental beyond the F#, and least of all a C## or an E##.
    expect(spellLineText([62, 66, 69, 67], 0)).toBe('D4 F#4 A4 G4');
  });

  it('keeps a chromatic run on one side of the key signature', () => {
    // A run only reads as a run when every note takes the same kind of
    // accidental: rising notes are written with sharps and falling notes with
    // flats, so the eye follows the letters upward or downward without a turn.
    expect(spellLineText([67, 68, 69, 70, 71, 72, 73, 74], 0)).toBe('G4 G#4 A4 A#4 B4 C5 C#5 D5');
    expect(spellLineText([74, 73, 72, 71, 70, 69, 68, 67], 0)).toBe('D5 Db5 C5 B4 Bb4 A4 Ab4 G4');
  });

  it('spells a borrowed harmony as an interval, not as a stack of sharps', () => {
    // The intervals a leap is written with have to match the ones it sounds:
    // the flat sixth of C major arpeggiated is Ab–C–Eb, a triad, where
    // G#–C–D# would read as a diminished fourth and an augmented second.
    expect(spellLineText([56, 60, 63], 0)).toBe('Ab3 C4 Eb4');
    expect(spellLineText([65, 68, 72], 0)).toBe('F4 Ab4 C5');
    expect(spellLineText([59, 62, 65, 68], 0)).toBe('B3 D4 F4 Ab4');
  });

  it('leaves Cb and B# to the keys whose signature names them', () => {
    // Cb and B# are the two spellings that sit in the octave next to the pitch
    // they sound, so a B natural written Cb5 is engraved above the C it stands
    // below. Gb major's signature does name Cb, and C# major's names B#; in
    // any other key the lower neighbour of C is a plain B.
    expect(spellLineText([72, 71, 72], -2)).toBe('C5 B4 C5');
    expect(spellLineText([72, 71, 72], -6)).toBe('C5 Cb5 C5');
    expect(spellLineText([59, 60, 59], 6)).toBe('B3 C4 B3');
    expect(spellLineText([59, 60, 59], 7)).toBe('B3 B#3 B3');
  });

  it('spells every note in the key signature it is handed', () => {
    expect(spellLineText([60, 62, 64], 0)).toBe('C4 D4 E4');
    expect(spellLineText([60, 62, 64], -5)).toBe('C4 D4 E4');
    expect(spellLineText([61, 63, 66], -5)).toBe('Db4 Eb4 Gb4');
  });

  it('falls back to key-signature spelling when the line exceeds the solver budget', () => {
    // The solver refuses a line larger than its generation budget. Score export
    // still has to produce a document, so the line is spelled note by note from
    // the key signature instead of failing the export.
    const line = Array.from({ length: 111_112 }, (_, index) => ({
      midi: 60 + (index % 12),
      startBeat: index,
      durationBeat: 1,
    }));
    const spelled = spellLineInKeySignature(line, 0);
    expect(spelled).toHaveLength(line.length);
    expect(spelled.slice(0, 4)).toEqual([
      { step: 'C', alter: 0, octave: 4 },
      { step: 'C', alter: 1, octave: 4 },
      { step: 'D', alter: 0, octave: 4 },
      { step: 'D', alter: 1, octave: 4 },
    ]);
  });

  it('returns nothing for an empty line', () => {
    expect(spellLineInKeySignature([], 0)).toEqual([]);
  });
});

describe('keyToKeyFifths', () => {
  it('maps major keys to their signatures', () => {
    expect(keyToKeyFifths({ root: 0, mode: 0 })).toBe(0); // C major
    expect(keyToKeyFifths({ root: 7, mode: 0 })).toBe(1); // G major
    expect(keyToKeyFifths({ root: 5, mode: 0 })).toBe(-1); // F major
    expect(keyToKeyFifths({ root: 1, mode: 0 })).toBe(-5); // Db major
    expect(keyToKeyFifths({ root: 6, mode: 0 })).toBe(6); // F# major
  });

  it('maps minor keys via the relative major', () => {
    expect(keyToKeyFifths({ root: 9, mode: 1 })).toBe(0); // A minor
    expect(keyToKeyFifths({ root: 4, mode: 1 })).toBe(1); // E minor
    expect(keyToKeyFifths({ root: 2, mode: 1 })).toBe(-1); // D minor
    expect(keyToKeyFifths({ root: 1, mode: 1 })).toBe(4); // C# minor
  });

  it('handles the other diatonic modes', () => {
    expect(keyToKeyFifths({ root: 2, mode: 2 })).toBe(0); // D dorian
    expect(keyToKeyFifths({ root: 5, mode: 4 })).toBe(0); // F lydian
    expect(keyToKeyFifths({ root: 7, mode: 5 })).toBe(0); // G mixolydian
  });
});

describe('keyFifthsToKey', () => {
  it('returns the major tonic by default', () => {
    expect(keyFifthsToKey(0)).toEqual({ root: 0, mode: 0 });
    expect(keyFifthsToKey(1)).toEqual({ root: 7, mode: 0 });
    expect(keyFifthsToKey(-5)).toEqual({ root: 1, mode: 0 });
  });

  it('returns the requested mode tonic', () => {
    expect(keyFifthsToKey(0, 1)).toEqual({ root: 9, mode: 1 }); // A minor
    expect(keyFifthsToKey(4, 1)).toEqual({ root: 1, mode: 1 }); // C# minor
    expect(keyFifthsToKey(0, 2)).toEqual({ root: 2, mode: 2 }); // D dorian
  });

  it('round-trips with keyToKeyFifths across the canonical range', () => {
    for (let fifths = -5; fifths <= 6; fifths += 1) {
      for (const mode of [0, 1] as const) {
        expect(keyToKeyFifths(keyFifthsToKey(fifths, mode))).toBe(fifths);
      }
    }
  });
});

describe('project mode encoding', () => {
  it('shifts audio Mode ordinals by one', () => {
    expect(modeToProjectMode(0)).toBe(1); // Major
    expect(modeToProjectMode(1)).toBe(2); // Minor
    expect(modeToProjectMode(6)).toBe(7); // Locrian
  });

  it('inverts the shift and rejects unknown values', () => {
    expect(projectModeToMode(1)).toBe(0);
    expect(projectModeToMode(7)).toBe(6);
    expect(projectModeToMode(0)).toBeUndefined();
    expect(projectModeToMode(8)).toBeUndefined();
    expect(projectModeToMode(1.5)).toBeUndefined();
  });
});
