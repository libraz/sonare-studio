import { describe, expect, it } from 'vitest';
import {
  keyFifthsToKey,
  keyToKeyFifths,
  modeToProjectMode,
  projectModeToMode,
  spellPitch,
  spellPitchWithContext,
} from '@/notation/pitch-spelling';

describe('spellPitch', () => {
  it('spells naturals identically in every key', () => {
    for (const fifths of [-5, -1, 0, 1, 5]) {
      expect(spellPitch(60, fifths)).toEqual({ step: 'C', alter: 0, octave: 4 });
      expect(spellPitch(65, fifths)).toEqual({ step: 'F', alter: 0, octave: 4 });
      expect(spellPitch(71, fifths)).toEqual({ step: 'B', alter: 0, octave: 4 });
    }
  });

  it('spells black keys as sharps in C major (fifths = 0)', () => {
    expect(spellPitch(61, 0)).toEqual({ step: 'C', alter: 1, octave: 4 });
    expect(spellPitch(63, 0)).toEqual({ step: 'D', alter: 1, octave: 4 });
    expect(spellPitch(66, 0)).toEqual({ step: 'F', alter: 1, octave: 4 });
    expect(spellPitch(68, 0)).toEqual({ step: 'G', alter: 1, octave: 4 });
    expect(spellPitch(70, 0)).toEqual({ step: 'A', alter: 1, octave: 4 });
  });

  it('spells black keys as sharps in G major (fifths = 1)', () => {
    expect(spellPitch(66, 1)).toEqual({ step: 'F', alter: 1, octave: 4 });
    expect(spellPitch(61, 1)).toEqual({ step: 'C', alter: 1, octave: 4 });
  });

  it('spells black keys as flats in F major (fifths = -1)', () => {
    expect(spellPitch(70, -1)).toEqual({ step: 'B', alter: -1, octave: 4 });
    expect(spellPitch(63, -1)).toEqual({ step: 'E', alter: -1, octave: 4 });
  });

  it('spells black keys as flats in Db major (fifths = -5)', () => {
    expect(spellPitch(61, -5)).toEqual({ step: 'D', alter: -1, octave: 4 });
    expect(spellPitch(66, -5)).toEqual({ step: 'G', alter: -1, octave: 4 });
    expect(spellPitch(68, -5)).toEqual({ step: 'A', alter: -1, octave: 4 });
    expect(spellPitch(70, -5)).toEqual({ step: 'B', alter: -1, octave: 4 });
  });

  it('uses signature spellings across E#/Cb octave boundaries', () => {
    // F# major's leading tone is E#, not F natural.
    expect(spellPitch(65, 6)).toEqual({ step: 'E', alter: 1, octave: 4 });
    // Gb major's fourth degree is Cb; Cb4 is MIDI 59 rather than Cb3.
    expect(spellPitch(59, -6)).toEqual({ step: 'C', alter: -1, octave: 4 });
  });

  it('uses melodic and harmonic context for chromatic spellings and double sharps', () => {
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
    // A raised seventh can require F## when it resolves to G#.
    expect(spellPitchWithContext(67, 5, { nextMidi: 68 })).toMatchObject({
      step: 'F',
      alter: 2,
    });
    // G major's borrowed bVI is Eb, not D#.
    expect(spellPitchWithContext(63, 1, { chordRootMidi: 63 })).toMatchObject({
      step: 'E',
      alter: -1,
    });
  });

  it('uses MusicXML octaves (C4 = MIDI 60)', () => {
    expect(spellPitch(59, 0).octave).toBe(3);
    expect(spellPitch(60, 0).octave).toBe(4);
    expect(spellPitch(72, 0).octave).toBe(5);
    expect(spellPitch(0, 0)).toEqual({ step: 'C', alter: 0, octave: -1 });
    expect(spellPitch(127, 0)).toEqual({ step: 'G', alter: 0, octave: 9 });
  });

  it('rejects out-of-range MIDI numbers', () => {
    expect(() => spellPitch(-1, 0)).toThrow(RangeError);
    expect(() => spellPitch(128, 0)).toThrow(RangeError);
    expect(() => spellPitch(60.5, 0)).toThrow(RangeError);
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
