import { describe, expect, it } from 'vitest';
import {
  chordsFromAnnotation,
  type EditorChordSymbol,
  formatChordName,
  sanitizeChordSymbols,
  toProjectChordSymbol,
  toProjectChordSymbols,
} from '@/project/chords';

describe('formatChordName', () => {
  it('formats root + quality suffix', () => {
    expect(formatChordName({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 })).toBe('C');
    expect(formatChordName({ startPpq: 0, endPpq: 4, rootPc: 9, quality: 6 })).toBe('Am7');
    expect(formatChordName({ startPpq: 0, endPpq: 4, rootPc: 7, quality: 4 })).toBe('G7');
    expect(formatChordName({ startPpq: 0, endPpq: 4, rootPc: 2, quality: 1 })).toBe('Dm');
    expect(formatChordName({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 10 })).toBe('Cadd9');
    expect(formatChordName({ startPpq: 0, endPpq: 4, rootPc: 9, quality: 11 })).toBe('Am(add9)');
    expect(formatChordName({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 14 })).toBe('Cmaj9');
    expect(formatChordName({ startPpq: 0, endPpq: 4, rootPc: 7, quality: 15 })).toBe('G9');
  });

  it('appends a slash bass only when it differs from the root', () => {
    expect(formatChordName({ startPpq: 0, endPpq: 4, rootPc: 7, quality: 4, bassPc: 0 })).toBe(
      'G7/C',
    );
    expect(formatChordName({ startPpq: 0, endPpq: 4, rootPc: 7, quality: 4, bassPc: 7 })).toBe(
      'G7',
    );
  });
});

describe('sanitizeChordSymbols', () => {
  it('drops invalid roots and non-positive regions, and sorts by position', () => {
    const result = sanitizeChordSymbols([
      { startPpq: 8, endPpq: 12, rootPc: 5, quality: 0 },
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
      { startPpq: 4, endPpq: 4, rootPc: 2, quality: 1 }, // zero length
      { startPpq: 16, endPpq: 20, rootPc: 99, quality: 0 }, // bad root
    ]);
    expect(result.map((c) => c.startPpq)).toEqual([0, 8]);
  });

  it('clamps the slash bass and drops it when equal to the root', () => {
    const [a, b] = sanitizeChordSymbols([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0, bassPc: 0 },
      { startPpq: 4, endPpq: 8, rootPc: 0, quality: 0, bassPc: 7 },
    ]);
    expect(a.bassPc).toBeUndefined();
    expect(b.bassPc).toBe(7);
  });
});

describe('toProjectChordSymbol', () => {
  it('shifts the quality ordinal and uses the 255 slash-bass sentinel', () => {
    const symbol: EditorChordSymbol = { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 };
    expect(toProjectChordSymbol(symbol)).toEqual({
      startPpq: 0,
      endPpq: 4,
      rootPc: 0,
      quality: 1,
      slashBassPc: 255,
    });
  });

  it('carries the slash bass, extensions, and roman numeral when present', () => {
    const symbol: EditorChordSymbol = {
      startPpq: 4,
      endPpq: 8,
      rootPc: 7,
      quality: 4,
      bassPc: 0,
      extensions: [10],
      romanNumeral: 'V',
    };
    expect(toProjectChordSymbol(symbol)).toEqual({
      startPpq: 4,
      endPpq: 8,
      rootPc: 7,
      quality: 5,
      slashBassPc: 0,
      extensions: [10],
      romanNumeral: 'V',
    });
  });

  it('maps a list', () => {
    expect(toProjectChordSymbols([{ startPpq: 0, endPpq: 4, rootPc: 2, quality: 1 }])).toEqual([
      { startPpq: 0, endPpq: 4, rootPc: 2, quality: 2, slashBassPc: 255 },
    ]);
  });
});

describe('chordsFromAnnotation', () => {
  it('reads the Project annotation stream back into editor symbols', () => {
    const symbols = chordsFromAnnotation({
      chords: [
        {
          start_ppq: 4,
          end_ppq: 8,
          root_pc: 7,
          quality: 5,
          slash_bass_pc: 0,
          roman_numeral: 'V',
          extensions: [10],
        },
        {
          start_ppq: 0,
          end_ppq: 4,
          root_pc: 0,
          quality: 1,
          slash_bass_pc: 255,
          roman_numeral: '',
        },
      ],
    });
    expect(symbols).toEqual([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
      {
        startPpq: 4,
        endPpq: 8,
        rootPc: 7,
        quality: 4,
        bassPc: 0,
        extensions: [10],
        romanNumeral: 'V',
      },
    ]);
  });

  it('returns an empty list for absent or malformed annotation', () => {
    expect(chordsFromAnnotation(undefined)).toEqual([]);
    expect(chordsFromAnnotation(null)).toEqual([]);
    expect(chordsFromAnnotation({})).toEqual([]);
    expect(chordsFromAnnotation({ chords: 'nope' })).toEqual([]);
  });

  it('skips entries with an out-of-range root', () => {
    const symbols = chordsFromAnnotation({
      chords: [{ start_ppq: 0, end_ppq: 4, root_pc: 255, quality: 0, slash_bass_pc: 255 }],
    });
    expect(symbols).toEqual([]);
  });
});
