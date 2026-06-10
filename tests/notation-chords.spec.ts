import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChordEstimateOptions,
  canonicalizeChordSymbols,
  type EstimatedChordSymbol,
  estimateChordSymbols,
} from '@/notation/chords';
import type { EditorNote } from '@/project/types';

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

  it('spells roots with flats in flat keys', () => {
    const symbols = estimateChordSymbols([note(58, 0, 4), note(62, 0, 4), note(65, 0, 4)], {
      ...OPTIONS,
      keyFifths: -2,
    });
    expect(symbols[0]).toMatchObject({ text: 'Bb', rootPc: 10 });
  });

  it('skips empty and single-pitch-class measures', () => {
    const symbols = estimateChordSymbols([note(60, 0, 2), note(72, 0, 2)], OPTIONS);
    expect(symbols).toHaveLength(0);
  });

  it('throws on a non-positive clip window', () => {
    expect(() => estimateChordSymbols([], { ...OPTIONS, clipLengthPpq: 0 })).toThrow(RangeError);
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
