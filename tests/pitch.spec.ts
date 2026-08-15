import { midiToNote, noteNames } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { formatPitch, PITCH_CLASS_NAMES, parsePitch } from '@/lib/pitch';

/** The sharp-spelled name of every MIDI pitch, indexed by MIDI note number. */
const EXPECTED_PITCH_NAMES: readonly string[] = [
  'C-1',
  'C#-1',
  'D-1',
  'D#-1',
  'E-1',
  'F-1',
  'F#-1',
  'G-1',
  'G#-1',
  'A-1',
  'A#-1',
  'B-1',
  'C0',
  'C#0',
  'D0',
  'D#0',
  'E0',
  'F0',
  'F#0',
  'G0',
  'G#0',
  'A0',
  'A#0',
  'B0',
  'C1',
  'C#1',
  'D1',
  'D#1',
  'E1',
  'F1',
  'F#1',
  'G1',
  'G#1',
  'A1',
  'A#1',
  'B1',
  'C2',
  'C#2',
  'D2',
  'D#2',
  'E2',
  'F2',
  'F#2',
  'G2',
  'G#2',
  'A2',
  'A#2',
  'B2',
  'C3',
  'C#3',
  'D3',
  'D#3',
  'E3',
  'F3',
  'F#3',
  'G3',
  'G#3',
  'A3',
  'A#3',
  'B3',
  'C4',
  'C#4',
  'D4',
  'D#4',
  'E4',
  'F4',
  'F#4',
  'G4',
  'G#4',
  'A4',
  'A#4',
  'B4',
  'C5',
  'C#5',
  'D5',
  'D#5',
  'E5',
  'F5',
  'F#5',
  'G5',
  'G#5',
  'A5',
  'A#5',
  'B5',
  'C6',
  'C#6',
  'D6',
  'D#6',
  'E6',
  'F6',
  'F#6',
  'G6',
  'G#6',
  'A6',
  'A#6',
  'B6',
  'C7',
  'C#7',
  'D7',
  'D#7',
  'E7',
  'F7',
  'F#7',
  'G7',
  'G#7',
  'A7',
  'A#7',
  'B7',
  'C8',
  'C#8',
  'D8',
  'D#8',
  'E8',
  'F8',
  'F#8',
  'G8',
  'G#8',
  'A8',
  'A#8',
  'B8',
  'C9',
  'C#9',
  'D9',
  'D#9',
  'E9',
  'F9',
  'F#9',
  'G9',
];

describe('PITCH_CLASS_NAMES', () => {
  it('lists the twelve sharp-spelled pitch classes in order', () => {
    expect([...PITCH_CLASS_NAMES]).toEqual([
      'C',
      'C#',
      'D',
      'D#',
      'E',
      'F',
      'F#',
      'G',
      'G#',
      'A',
      'A#',
      'B',
    ]);
  });

  it('matches the note names libcantus spells for the same pitch classes', () => {
    const bare = Array.from({ length: 12 }, (_unused, pitchClass) => {
      const { letter, alter } = midiToNote(pitchClass, 'sharp');
      return { letter, alter };
    });
    expect(noteNames(bare)).toEqual([...PITCH_CLASS_NAMES]);
  });
});

describe('formatPitch', () => {
  it('names every MIDI pitch', () => {
    const names = Array.from({ length: 128 }, (_unused, midi) => formatPitch(midi));
    expect(names).toEqual(EXPECTED_PITCH_NAMES);
  });

  it('formats middle C (60) as C4', () => {
    expect(formatPitch(60)).toBe('C4');
  });

  it('formats sharps with the sharp spelling', () => {
    expect(formatPitch(61)).toBe('C#4');
    expect(formatPitch(70)).toBe('A#4');
  });

  it('formats the range endpoints', () => {
    expect(formatPitch(0)).toBe('C-1');
    expect(formatPitch(127)).toBe('G9');
  });

  it('formats A4 (69) per the A440 convention', () => {
    expect(formatPitch(69)).toBe('A4');
  });

  it('throws on non-integer or out-of-range input', () => {
    expect(() => formatPitch(-1)).toThrow(RangeError);
    expect(() => formatPitch(128)).toThrow(RangeError);
    expect(() => formatPitch(60.5)).toThrow(RangeError);
    expect(() => formatPitch(Number.NaN)).toThrow(RangeError);
  });

  it('covers all twelve pitch class names', () => {
    for (let pc = 0; pc < 12; pc++) {
      expect(formatPitch(60 + pc)).toBe(`${PITCH_CLASS_NAMES[pc]}4`);
    }
  });
});

describe('parsePitch', () => {
  it('parses natural note names', () => {
    expect(parsePitch('C4')).toBe(60);
    expect(parsePitch('A4')).toBe(69);
    expect(parsePitch('G9')).toBe(127);
    expect(parsePitch('C-1')).toBe(0);
  });

  it('parses sharps and flats including unicode accidentals', () => {
    expect(parsePitch('C#4')).toBe(61);
    expect(parsePitch('Db4')).toBe(61);
    expect(parsePitch('C♯4')).toBe(61);
    expect(parsePitch('D♭4')).toBe(61);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(parsePitch('  c#4 ')).toBe(61);
    expect(parsePitch('bB3')).toBe(58);
  });

  it('parses plain MIDI numbers', () => {
    expect(parsePitch('60')).toBe(60);
    expect(parsePitch('0')).toBe(0);
    expect(parsePitch('127')).toBe(127);
  });

  it('resolves enharmonics across octave boundaries', () => {
    expect(parsePitch('Cb4')).toBe(59); // = B3
    expect(parsePitch('B#3')).toBe(60); // = C4
  });

  it('round-trips every formatted pitch', () => {
    for (let midi = 0; midi <= 127; midi++) {
      expect(parsePitch(formatPitch(midi))).toBe(midi);
    }
  });

  it('returns null for out-of-range pitches', () => {
    expect(parsePitch('128')).toBeNull();
    expect(parsePitch('-1')).toBeNull();
    expect(parsePitch('G#9')).toBeNull(); // 128
    expect(parsePitch('Cb-1')).toBeNull(); // -1
    expect(parsePitch('C10')).toBeNull();
  });

  it('returns null for non-pitch text', () => {
    expect(parsePitch('')).toBeNull();
    expect(parsePitch('   ')).toBeNull();
    expect(parsePitch('H2')).toBeNull();
    expect(parsePitch('C')).toBeNull();
    expect(parsePitch('#4')).toBeNull();
    expect(parsePitch('C#')).toBeNull();
    expect(parsePitch('12.5')).toBeNull();
    expect(parsePitch('C#4x')).toBeNull();
  });
});
