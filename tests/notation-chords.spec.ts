import { beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateChordsFromTracks } from '@/compose/estimate-chords';
import {
  type ChordEstimateOptions,
  canonicalizeChordSymbols,
  type EstimatedChordSymbol,
  estimateChordSymbols,
} from '@/notation/chords';
import { chordTonePitchClasses } from '@/project/chords';
import type { EditorNote, EditorTrack } from '@/project/types';

/** Shared mock state for the fake wasm Project used by canonicalize tests. */
const wasmState = vi.hoisted(() => ({
  annotated: [] as Array<Record<string, unknown>>,
  deleted: 0,
  json: '',
  failAnnotate: false,
}));

vi.mock('@/lib/wasm', () => ({
  ensureWasm: async () => ({
    Project: class {
      annotateChords(chords: Array<Record<string, unknown>>): void {
        if (wasmState.failAnnotate) throw new Error('annotate failed');
        wasmState.annotated = chords;
      }
      toJson(): string {
        return wasmState.json;
      }
      delete(): void {
        wasmState.deleted++;
      }
    },
  }),
}));

let nextId = 1;

function note(pitch: number, startPpq: number, durationPpq: number): EditorNote {
  return { id: nextId++, pitch, velocity: 96, startPpq, durationPpq, channel: 0 };
}

/** The pitch classes an estimated symbol asks to sound. */
function soundedPitchClasses(symbol: EstimatedChordSymbol): number[] {
  return chordTonePitchClasses({
    startPpq: symbol.ppq,
    endPpq: symbol.endPpq,
    rootPc: symbol.rootPc ?? 0,
    quality: symbol.quality ?? 0,
    ...(symbol.extensions === undefined ? {} : { extensions: [...symbol.extensions] }),
    ...(symbol.omissions === undefined ? {} : { omissions: [...symbol.omissions] }),
  });
}

const OPTIONS: ChordEstimateOptions = {
  clipStartPpq: 0,
  clipLengthPpq: 8,
  measureLengthPpq: 4,
  keyFifths: 0,
};

describe('estimateChordSymbols', () => {
  it('detects a major triad and names it after the root', () => {
    const symbols = estimateChordSymbols([note(60, 0, 4), note(64, 0, 4), note(67, 0, 4)], OPTIONS);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ ppq: 0, endPpq: 4, text: 'C', rootPc: 0, quality: 0 });
    expect(symbols[0].bassPc).toBeUndefined();
  });

  it('detects seventh chords with per-measure positions', () => {
    const symbols = estimateChordSymbols(
      [
        // Measure 1: Cmaj7, measure 2: G7.
        note(60, 0, 4),
        note(64, 0, 4),
        note(67, 0, 4),
        note(71, 0, 4),
        note(55, 4, 4),
        note(59, 4, 4),
        note(62, 4, 4),
        note(65, 4, 4),
      ],
      OPTIONS,
    );
    expect(symbols).toHaveLength(2);
    expect(symbols[0]).toMatchObject({ ppq: 0, text: 'Cmaj7', rootPc: 0, quality: 5 });
    expect(symbols[1]).toMatchObject({ ppq: 4, text: 'G7', rootPc: 7, quality: 4 });
  });

  it('detects add9 and ninth chord qualities before falling back to triads or sevenths', () => {
    const symbols = estimateChordSymbols(
      [
        // Measure 1: Cadd9, measure 2: G9.
        note(60, 0, 4),
        note(64, 0, 4),
        note(67, 0, 4),
        note(62, 0, 4),
        note(55, 4, 4),
        note(59, 4, 4),
        note(62, 4, 4),
        note(65, 4, 4),
        note(69, 4, 4),
      ],
      OPTIONS,
    );
    expect(symbols).toHaveLength(2);
    expect(symbols[0]).toMatchObject({ ppq: 0, text: 'Cadd9', rootPc: 0, quality: 10 });
    expect(symbols[1]).toMatchObject({ ppq: 4, text: 'G9', rootPc: 7, quality: 15 });
  });

  it('detects sixth, suspended and extended dominant chord vocabularies', () => {
    const symbols = estimateChordSymbols(
      [
        // C6
        note(60, 0, 4),
        note(64, 0, 4),
        note(67, 0, 4),
        note(69, 0, 4),
        // G7sus4
        note(55, 4, 4),
        note(60, 4, 4),
        note(62, 4, 4),
        note(65, 4, 4),
        // C13
        note(60, 8, 4),
        note(64, 8, 4),
        note(67, 8, 4),
        note(70, 8, 4),
        note(62, 8, 4),
        note(69, 8, 4),
      ],
      { ...OPTIONS, clipLengthPpq: 12 },
    );

    expect(symbols).toMatchObject([
      { ppq: 0, text: 'C6', rootPc: 0, quality: 0, extensions: [9] },
      { ppq: 4, text: 'G7sus4', rootPc: 7, quality: 8, extensions: [10] },
      // The notes sound the ninth, and so does the quality that names them.
      { ppq: 8, text: 'C13', rootPc: 0, quality: 4, extensions: [2, 9] },
    ]);
  });

  // A shell voicing states its quality with the third and the seventh and
  // leaves the fifth out. Reading it as the triad the key prefers would assert
  // a fifth nobody played and drop the tritone that carries the chord, so these
  // pin the seventh surviving across the qualities that share the voicing.
  it('detects a seventh chord voiced without its fifth', () => {
    const shell = (third: number, seventh: number) =>
      estimateChordSymbols([note(60, 0, 4), note(third, 0, 4), note(seventh, 0, 4)], OPTIONS)[0];

    expect(shell(64, 70)).toMatchObject({ ppq: 0, text: 'C7', rootPc: 0, quality: 4 });
    expect(shell(64, 71)).toMatchObject({ ppq: 0, text: 'Cmaj7', rootPc: 0, quality: 5 });
    expect(shell(63, 70)).toMatchObject({ ppq: 0, text: 'Cm7', rootPc: 0, quality: 6 });
  });

  // An augmented sixth is named after the nearest quality the analysis has, a
  // dominant seventh, while the chord sounds no fifth. The displayed symbol has
  // to say so, or the score would state a tone the passage never sounds.
  it('keeps the tones of an augmented sixth its quality only approximates', () => {
    const symbols = estimateChordSymbols(
      [
        note(60, 0, 4),
        note(64, 0, 4),
        note(67, 0, 4),
        // Ab, C, F# -- an Italian sixth.
        note(56, 4, 4),
        note(60, 4, 4),
        note(66, 4, 4),
      ],
      OPTIONS,
    );
    expect(symbols[1]).toMatchObject({ ppq: 4, rootPc: 8, quality: 4, omissions: [7] });
    // Exactly Ab, C and F#: reading the chord as Ab7 would add an Eb nothing plays.
    expect(soundedPitchClasses(symbols[1])).toEqual([0, 6, 8]);
    // The printed name says the same thing the tone set does, and says it the
    // way the chord track does.
    expect(symbols[1].text).toBe('Ab7(omit5)');
  });

  it('keeps an omitted fifth from re-reading a dominant as another chord', () => {
    const withNinth = estimateChordSymbols(
      [note(60, 0, 4), note(64, 0, 4), note(70, 0, 4), note(62, 0, 4)],
      OPTIONS,
    );
    expect(withNinth[0]).toMatchObject({ ppq: 0, text: 'C9', rootPc: 0, quality: 15 });

    const withSharpNinth = estimateChordSymbols(
      [note(60, 0, 4), note(64, 0, 4), note(70, 0, 4), note(63, 0, 4)],
      OPTIONS,
    );
    expect(withSharpNinth[0]).toMatchObject({ ppq: 0, text: 'C7#9', rootPc: 0, quality: 4 });
  });

  // The window's root is read from the bass rather than from whichever pitch
  // class was struck hardest, so a shell voicing whose seventh carries the
  // velocity is not re-rooted onto that seventh.
  it('roots a shell voicing on its bass, not on its loudest tone', () => {
    const symbols = estimateChordSymbols(
      [
        { ...note(60, 0, 4), velocity: 40 },
        { ...note(64, 0, 4), velocity: 40 },
        { ...note(70, 0, 4), velocity: 127 },
      ],
      OPTIONS,
    );
    expect(symbols[0]).toMatchObject({ ppq: 0, text: 'C7', rootPc: 0, quality: 4 });
  });

  it('detects minor add9 and major ninth qualities', () => {
    const symbols = estimateChordSymbols(
      [
        // Measure 1: Am(add9), measure 2: Cmaj9.
        note(57, 0, 4),
        note(60, 0, 4),
        note(64, 0, 4),
        note(59, 0, 4),
        note(60, 4, 4),
        note(64, 4, 4),
        note(67, 4, 4),
        note(71, 4, 4),
        note(62, 4, 4),
      ],
      OPTIONS,
    );
    expect(symbols).toHaveLength(2);
    expect(symbols[0]).toMatchObject({ ppq: 0, text: 'Am(add9)', rootPc: 9, quality: 11 });
    expect(symbols[1]).toMatchObject({ ppq: 4, text: 'Cmaj9', rootPc: 0, quality: 14 });
  });

  it('uses actual score measure windows when provided', () => {
    const symbols = estimateChordSymbols(
      [
        // 4/4 bar: C, then 3/4 bar starting at PPQ 4: G.
        note(60, 0, 4),
        note(64, 0, 4),
        note(67, 0, 4),
        note(55, 4, 3),
        note(59, 4, 3),
        note(62, 4, 3),
        // Next 3/4 bar starts at PPQ 7; fixed 4-PPQ windows would miss this boundary.
        note(65, 7, 3),
        note(69, 7, 3),
        note(72, 7, 3),
      ],
      {
        ...OPTIONS,
        clipLengthPpq: 10,
        measures: [
          { startPpq: 0, lengthPpq: 4 },
          { startPpq: 4, lengthPpq: 3 },
          { startPpq: 7, lengthPpq: 3 },
        ],
      },
    );

    expect(
      symbols.map((symbol) => ({
        ppq: symbol.ppq,
        endPpq: symbol.endPpq,
        text: symbol.text,
      })),
    ).toEqual([
      { ppq: 0, endPpq: 4, text: 'C' },
      { ppq: 4, endPpq: 7, text: 'G' },
      { ppq: 7, endPpq: 10, text: 'F' },
    ]);
  });

  it('detects a minor triad', () => {
    const symbols = estimateChordSymbols([note(57, 0, 4), note(60, 0, 4), note(64, 0, 4)], OPTIONS);
    expect(symbols[0]).toMatchObject({ text: 'Am', rootPc: 9, quality: 1 });
  });

  it('emits a slash chord when the bass differs from the root', () => {
    const symbols = estimateChordSymbols(
      [note(52, 0, 4), note(60, 0, 4), note(64, 0, 4), note(67, 0, 4)],
      OPTIONS,
    );
    expect(symbols[0]).toMatchObject({ text: 'C/E', rootPc: 0, bassPc: 4 });
  });

  it('uses the opening bass instead of a later passing low note for inversions', () => {
    const symbols = estimateChordSymbols(
      [note(53, 0, 4), note(57, 0, 4), note(60, 0, 4), note(48, 2, 1)],
      OPTIONS,
    );

    expect(symbols[0]).toMatchObject({ text: 'F', rootPc: 5 });
    expect(symbols[0].bassPc).toBeUndefined();
  });

  it('uses the lowest pitch at the first delayed onset when the window starts empty', () => {
    const symbols = estimateChordSymbols(
      [
        note(64, 1, 3),
        note(67, 1, 3),
        note(72, 1, 3),
        // This later low root must not replace the first-onset inversion bass.
        note(48, 2, 1),
      ],
      OPTIONS,
    );

    expect(symbols[0]).toMatchObject({ text: 'C/E', rootPc: 0, bassPc: 4 });
  });

  it('spells roots with flats in flat keys', () => {
    const symbols = estimateChordSymbols([note(58, 0, 4), note(62, 0, 4), note(65, 0, 4)], {
      ...OPTIONS,
      keyFifths: -2,
    });
    expect(symbols[0]).toMatchObject({ text: 'Bb', rootPc: 10 });
  });

  it('skips empty measures and names a bare octave without a third', () => {
    const symbols = estimateChordSymbols([note(60, 0, 2), note(72, 0, 2)], OPTIONS);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ ppq: 0, endPpq: 4, text: 'C5', rootPc: 0 });
  });

  it('does not infer chords from GM percussion-channel notes', () => {
    const symbols = estimateChordSymbols(
      [note(36, 0, 4), note(40, 0, 4), note(43, 0, 4)].map((drum) => ({
        ...drum,
        channel: 9,
      })),
      OPTIONS,
    );
    expect(symbols).toEqual([]);
  });

  it('throws on a non-positive clip window', () => {
    expect(() => estimateChordSymbols([], { ...OPTIONS, clipLengthPpq: 0 })).toThrow(RangeError);
  });
});

describe('score and chord-track detection agree', () => {
  const progression = [
    // Cmaj7 | Am7 | Dm7 | G7
    note(60, 0, 4),
    note(64, 0, 4),
    note(67, 0, 4),
    note(71, 0, 4),
    note(57, 4, 4),
    note(60, 4, 4),
    note(64, 4, 4),
    note(67, 4, 4),
    note(62, 8, 4),
    note(65, 8, 4),
    note(69, 8, 4),
    note(72, 8, 4),
    note(55, 12, 4),
    note(59, 12, 4),
    note(62, 12, 4),
    note(65, 12, 4),
  ];

  it('produces the same chord over the same span from both entry points', () => {
    const scoreSymbols = estimateChordSymbols(progression, {
      ...OPTIONS,
      clipLengthPpq: 16,
    });
    const trackSymbols = estimateChordsFromTracks(
      [{ track: { id: 1, name: 'Piano' } as EditorTrack, notes: progression }],
      { timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }] },
    ).symbols;

    expect(
      scoreSymbols.map((symbol) => ({
        startPpq: symbol.ppq,
        endPpq: symbol.endPpq,
        rootPc: symbol.rootPc,
        quality: symbol.quality,
        extensions: symbol.extensions,
      })),
    ).toEqual(
      trackSymbols.map((symbol) => ({
        startPpq: symbol.startPpq,
        endPpq: symbol.endPpq,
        rootPc: symbol.rootPc,
        quality: symbol.quality,
        extensions: symbol.extensions,
      })),
    );
    expect(scoreSymbols.length).toBeGreaterThan(1);
  });

  it('agrees across a measure-length change', () => {
    const notes = [
      // 4/4 bar, then two 3/4 bars.
      note(60, 0, 4),
      note(64, 0, 4),
      note(67, 0, 4),
      note(55, 4, 3),
      note(59, 4, 3),
      note(62, 4, 3),
      note(65, 7, 3),
      note(69, 7, 3),
      note(72, 7, 3),
    ];
    const scoreSymbols = estimateChordSymbols(notes, {
      ...OPTIONS,
      clipLengthPpq: 10,
      measures: [
        { startPpq: 0, lengthPpq: 4 },
        { startPpq: 4, lengthPpq: 3 },
        { startPpq: 7, lengthPpq: 3 },
      ],
    });
    const trackSymbols = estimateChordsFromTracks(
      [{ track: { id: 1, name: 'Piano' } as EditorTrack, notes }],
      {
        timeSignatures: [
          { startPpq: 0, numerator: 4, denominator: 4 },
          { startPpq: 4, numerator: 3, denominator: 4 },
        ],
      },
    ).symbols;

    expect(
      scoreSymbols.map((symbol) => [symbol.ppq, symbol.endPpq, symbol.rootPc, symbol.quality]),
    ).toEqual(
      trackSymbols.map((symbol) => [symbol.startPpq, symbol.endPpq, symbol.rootPc, symbol.quality]),
    );
  });
});

describe('canonicalizeChordSymbols', () => {
  beforeEach(() => {
    wasmState.annotated = [];
    wasmState.deleted = 0;
    wasmState.json = '';
    wasmState.failAnnotate = false;
  });

  const estimated: EstimatedChordSymbol[] = [
    { ppq: 0, endPpq: 4, text: 'C', rootPc: 0, quality: 0 },
    { ppq: 4, endPpq: 8, text: 'G7/B', rootPc: 7, quality: 4, bassPc: 11 },
  ];

  it('writes the shifted project encoding and reads back audio-domain ordinals', async () => {
    wasmState.json = JSON.stringify({
      annotation: {
        chords: [
          {
            start_ppq: 0,
            end_ppq: 4,
            root_pc: 0,
            quality: 1,
            slash_bass_pc: 255,
            roman_numeral: '',
          },
          {
            start_ppq: 4,
            end_ppq: 8,
            root_pc: 7,
            quality: 5,
            slash_bass_pc: 11,
            roman_numeral: '',
          },
        ],
      },
    });
    const symbols = await canonicalizeChordSymbols(estimated);
    expect(wasmState.annotated).toEqual([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 1, slashBassPc: 255 },
      { startPpq: 4, endPpq: 8, rootPc: 7, quality: 5, slashBassPc: 11 },
    ]);
    expect(symbols).toEqual([
      { ppq: 0, text: 'C', rootPc: 0, quality: 0 },
      { ppq: 4, text: 'G7/B', rootPc: 7, quality: 4, bassPc: 11 },
    ]);
    expect(wasmState.deleted).toBe(1);
  });

  it('round-trips extension tones through the Project annotation encoding', async () => {
    const extended: EstimatedChordSymbol[] = [
      { ppq: 0, endPpq: 4, text: 'C13', rootPc: 0, quality: 4, extensions: [2, 9] },
    ];
    wasmState.json = JSON.stringify({
      annotation: {
        chords: [
          {
            start_ppq: 0,
            end_ppq: 4,
            root_pc: 0,
            quality: 5,
            slash_bass_pc: 255,
            roman_numeral: '',
            extensions: [2, 9],
          },
        ],
      },
    });

    await expect(canonicalizeChordSymbols(extended)).resolves.toEqual([
      { ppq: 0, text: 'C13', rootPc: 0, quality: 4, extensions: [2, 9] },
    ]);
    expect(wasmState.annotated).toEqual([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 5, slashBassPc: 255, extensions: [2, 9] },
    ]);
  });

  it('drops entries with sentinel roots', async () => {
    wasmState.json = JSON.stringify({
      annotation: {
        chords: [
          {
            start_ppq: 0,
            end_ppq: 4,
            root_pc: 255,
            quality: 0,
            slash_bass_pc: 255,
            roman_numeral: '',
          },
        ],
      },
    });
    const symbols = await canonicalizeChordSymbols(estimated.slice(0, 1));
    expect(symbols).toEqual([]);
  });

  it('releases the scratch project and rejects when the wasm call fails', async () => {
    wasmState.failAnnotate = true;
    await expect(canonicalizeChordSymbols(estimated)).rejects.toThrow('annotate failed');
    expect(wasmState.deleted).toBe(1);
  });

  it('returns an empty list without touching wasm for empty input', async () => {
    const symbols = await canonicalizeChordSymbols([]);
    expect(symbols).toEqual([]);
    expect(wasmState.deleted).toBe(0);
  });
});
