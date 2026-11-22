import type { ProjectChordSymbol } from '@libraz/libsonare';
import { describe, expect, it } from 'vitest';
import { TONE_PCS_BY_QUALITY } from '@/compose/chord-quality';
import {
  chordsFromAnnotation,
  type EditorChordSymbol,
  formatChordName,
  sameChord,
  sanitizeChordSymbols,
  toProjectChordSymbol,
  toProjectChordSymbols,
} from '@/project/chords';
import type { NativeAnnotationChord } from '@/project/native-document';
import { readSource } from './helpers/source-text';

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
  it('folds the quality ordinal into a core family and omits an absent slash bass', () => {
    const symbol: EditorChordSymbol = { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 };
    expect(toProjectChordSymbol(symbol)).toEqual({
      startPpq: 0,
      endPpq: 4,
      rootPc: 0,
      quality: 'major',
    });
  });

  it('carries seventh and ninth ordinals as degrees of their family', () => {
    const encode = (quality: number) => {
      const { quality: family, extensions } = toProjectChordSymbol({
        startPpq: 0,
        endPpq: 1,
        rootPc: 0,
        quality,
      });
      return [family, extensions];
    };
    expect(encode(5)).toEqual(['major', [7]]);
    expect(encode(13)).toEqual(['halfDiminished', [7]]);
    expect(encode(8)).toEqual(['suspended', [4]]);
    expect(encode(15)).toEqual(['dominant', [7, 9]]);
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
      quality: 'dominant',
      slashBassPc: 0,
      extensions: [7, 9],
      romanNumeral: 'V',
    });
  });

  it('maps a list', () => {
    expect(toProjectChordSymbols([{ startPpq: 0, endPpq: 4, rootPc: 2, quality: 1 }])).toEqual([
      { startPpq: 0, endPpq: 4, rootPc: 2, quality: 'minor' },
    ]);
  });
});

/** The stored `toJson()` form of an annotation entry. */
function toStored(symbol: ProjectChordSymbol): NativeAnnotationChord {
  return {
    startPpq: symbol.startPpq,
    endPpq: symbol.endPpq,
    rootPc: symbol.rootPc ?? 255,
    quality: symbol.quality ?? 'unknown',
    slashBassPc: symbol.slashBassPc ?? 255,
    romanNumeral: symbol.romanNumeral ?? '',
    extensions: [...(symbol.extensions ?? [])],
  };
}

describe('chordsFromAnnotation', () => {
  it('reads the Project annotation stream back into editor symbols', () => {
    const symbols = chordsFromAnnotation({
      chords: [
        {
          startPpq: 4,
          endPpq: 8,
          rootPc: 7,
          quality: 'dominant',
          slashBassPc: 0,
          romanNumeral: 'V',
          extensions: [7, 13],
        },
        {
          startPpq: 0,
          endPpq: 4,
          rootPc: 0,
          quality: 'major',
          slashBassPc: 255,
          romanNumeral: '',
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
        extensions: [9],
        romanNumeral: 'V',
      },
    ]);
  });

  it('restores a hinted chord whose structure the Project encoding folds away', () => {
    const hint: EditorChordSymbol = {
      startPpq: 0,
      endPpq: 4,
      rootPc: 0,
      quality: 4,
      extensions: [2, 9],
    };
    const annotation = { chords: [toStored(toProjectChordSymbol(hint))] };
    expect(chordsFromAnnotation(annotation)[0]).not.toEqual(hint);
    expect(chordsFromAnnotation(annotation, [hint])).toEqual([hint]);
  });

  it('lets the Project win when it no longer holds the hinted chord', () => {
    const hint: EditorChordSymbol = { startPpq: 0, endPpq: 4, rootPc: 0, quality: 4 };
    const changed = toStored(toProjectChordSymbol({ ...hint, rootPc: 7 }));
    expect(chordsFromAnnotation({ chords: [changed] }, [hint])[0].rootPc).toBe(7);
  });

  it('returns an empty list for absent or malformed annotation', () => {
    expect(chordsFromAnnotation(undefined)).toEqual([]);
    expect(chordsFromAnnotation(null)).toEqual([]);
    expect(chordsFromAnnotation({})).toEqual([]);
    expect(chordsFromAnnotation({ chords: 'nope' })).toEqual([]);
  });

  it('skips entries with an out-of-range root', () => {
    const symbols = chordsFromAnnotation({
      chords: [{ startPpq: 0, endPpq: 4, rootPc: 255, quality: 'unknown', slashBassPc: 255 }],
    });
    expect(symbols).toEqual([]);
  });
});

describe('TONE_PCS_BY_QUALITY', () => {
  it('all 15 qualities have the expected pitch classes', () => {
    expect(TONE_PCS_BY_QUALITY[0]).toEqual([0, 4, 7]);
    expect(TONE_PCS_BY_QUALITY[1]).toEqual([0, 3, 7]);
    expect(TONE_PCS_BY_QUALITY[2]).toEqual([0, 3, 6]);
    expect(TONE_PCS_BY_QUALITY[3]).toEqual([0, 4, 8]);
    expect(TONE_PCS_BY_QUALITY[4]).toEqual([0, 4, 7, 10]);
    expect(TONE_PCS_BY_QUALITY[5]).toEqual([0, 4, 7, 11]);
    expect(TONE_PCS_BY_QUALITY[6]).toEqual([0, 3, 7, 10]);
    expect(TONE_PCS_BY_QUALITY[7]).toEqual([0, 2, 7]);
    expect(TONE_PCS_BY_QUALITY[8]).toEqual([0, 5, 7]);
    expect(TONE_PCS_BY_QUALITY[10]).toEqual([0, 2, 4, 7]);
    expect(TONE_PCS_BY_QUALITY[11]).toEqual([0, 2, 3, 7]);
    expect(TONE_PCS_BY_QUALITY[12]).toEqual([0, 3, 6, 9]);
    expect(TONE_PCS_BY_QUALITY[13]).toEqual([0, 3, 6, 10]);
    expect(TONE_PCS_BY_QUALITY[14]).toEqual([0, 2, 4, 7, 11]);
    expect(TONE_PCS_BY_QUALITY[15]).toEqual([0, 2, 4, 7, 10]);
  });

  it('chord-quality.ts source does not contain a hand-written pitch class table', () => {
    const source = readSource('src/compose/chord-quality.ts');
    // Pattern matches: TONE_PCS_BY_QUALITY = { 0: [ (the hand-written table start)
    const handWrittenTablePattern = /TONE_PCS_BY_QUALITY[^=]*=\s*\{\s*0:\s*\[/;
    expect(source).not.toMatch(handWrittenTablePattern);
  });
});
