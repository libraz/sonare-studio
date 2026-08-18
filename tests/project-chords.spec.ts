import { describe, expect, it } from 'vitest';
import {
  chordsFromAnnotation,
  type EditorChordSymbol,
  formatChordName,
  sameChord,
  sanitizeChordSymbols,
  toProjectChordSymbol,
  toProjectChordSymbols,
} from '@/project/chords';

describe('sameChord', () => {
  const base: EditorChordSymbol = { startPpq: 0, endPpq: 4, rootPc: 0, quality: 4 };

  it('ignores the timeline region when comparing identity', () => {
    expect(sameChord(base, { ...base, startPpq: 100, endPpq: 108 })).toBe(true);
  });

  it('distinguishes root, quality, and bass', () => {
    expect(sameChord(base, { ...base, rootPc: 7 })).toBe(false);
    expect(sameChord(base, { ...base, quality: 6 })).toBe(false);
    expect(sameChord(base, { ...base, bassPc: 7 })).toBe(false);
    expect(sameChord({ ...base, bassPc: 7 }, { ...base, bassPc: 7 })).toBe(true);
  });

  it('treats an absent bass as equal only to another absent bass', () => {
    expect(sameChord(base, { ...base, bassPc: undefined })).toBe(true);
    expect(sameChord({ ...base, bassPc: 0 }, base)).toBe(false);
  });

  it('distinguishes chords by the tones they add', () => {
    expect(sameChord(base, { ...base, extensions: [2] })).toBe(false);
    expect(sameChord({ ...base, extensions: [2] }, { ...base, extensions: [9] })).toBe(false);
    expect(sameChord({ ...base, extensions: [2, 9] }, { ...base, extensions: [9, 2] })).toBe(true);
    // A compound extension is the same tone as its simple interval, and a tone
    // the quality already sounds adds nothing.
    expect(sameChord({ ...base, extensions: [2] }, { ...base, extensions: [14] })).toBe(true);
    expect(sameChord(base, { ...base, extensions: [7, 10] })).toBe(true);
  });

  it('distinguishes a sounded intrinsic tone from an omitted one', () => {
    const powerChord: EditorChordSymbol = { ...base, quality: 0, omissions: [4] };
    expect(sameChord(powerChord, { ...base, quality: 0 })).toBe(false);
    expect(sameChord(powerChord, { ...powerChord, omissions: [16] })).toBe(true);
    // Only a tone the quality carries can be omitted, so an offset naming
    // neither an intrinsic tone nor the root leaves the chord unchanged.
    expect(sameChord({ ...base, quality: 0 }, { ...base, quality: 0, omissions: [6, 0] })).toBe(
      true,
    );
  });
});

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

  it('uses functional flat spellings for borrowed chord degrees, including slash basses', () => {
    expect(formatChordName({ startPpq: 0, endPpq: 4, rootPc: 10, quality: 0, bassPc: 3 }, -2)).toBe(
      'Bb/Eb',
    );
    expect(formatChordName({ startPpq: 0, endPpq: 4, rootPc: 10, quality: 0 }, 2)).toBe('Bb');
    expect(formatChordName({ startPpq: 0, endPpq: 4, rootPc: 8, quality: 0 }, 0)).toBe('Ab');
    expect(formatChordName({ startPpq: 0, endPpq: 4, rootPc: 1, quality: 0 }, 0)).toBe('Db');
    expect(formatChordName({ startPpq: 0, endPpq: 4, rootPc: 6, quality: 0 }, 0)).toBe('F#');
  });

  it('formats normalized extensions as their complete chord quality', () => {
    expect(
      formatChordName({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 1, extensions: [14] }),
    ).toBe('Cm(add9)');
    expect(
      formatChordName({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 6, extensions: [2] }),
    ).toBe('Cm9');
    expect(
      formatChordName({ startPpq: 0, endPpq: 4, rootPc: 7, quality: 4, extensions: [13] }),
    ).toBe('G7b9');
    expect(
      formatChordName({
        startPpq: 0,
        endPpq: 4,
        rootPc: 7,
        quality: 4,
        extensions: [21],
        bassPc: 2,
      }),
    ).toBe('G13/D');
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

  it('normalizes, sorts, deduplicates, and removes intrinsic extensions', () => {
    const [chord] = sanitizeChordSymbols([
      {
        startPpq: 0,
        endPpq: 4,
        rootPc: 0,
        quality: 4,
        extensions: [13, 1, -11, 22, 0, 7],
      },
    ]);
    expect(chord.extensions).toEqual([1]);
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
      extensions: [13, 1],
      romanNumeral: 'V',
    };
    expect(toProjectChordSymbol(symbol)).toEqual({
      startPpq: 4,
      endPpq: 8,
      rootPc: 7,
      quality: 5,
      slashBassPc: 0,
      extensions: [1],
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
          extensions: [13],
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
        extensions: [1],
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
