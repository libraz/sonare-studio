import { describe, expect, it } from 'vitest';
import { formatPitch, PITCH_CLASS_NAMES, parsePitch } from '@/lib/pitch';

describe('formatPitch', () => {
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
