/**
 * Chord-symbol interchange between the editor's {@link EditorChordSymbol} and
 * libcantus's {@link ChordData}/{@link ChordSpan}.
 *
 * The two sides describe chord quality differently. The editor uses the
 * audio-domain quality ordinal (Major = 0), matching the templates in
 * src/notation/chords.ts and the wasm annotation encoding — a fixed set of ~15
 * qualities plus a free `extensions` list of semitone offsets. libcantus uses a
 * 30-member string union covering richer qualities (`7#9`, `min6`, `6/9`, ...).
 *
 * Mapping is therefore asymmetric:
 *   - editor -> libcantus promotes known base-plus-extension combinations to
 *     exact quality strings and otherwise carries the extensions in the
 *     returned ChordData interval set.
 *   - libcantus -> editor keeps the exact ordinal when one exists, otherwise
 *     degrades to a base ordinal plus an `extensions` list capturing the color
 *     tones (see {@link LIBCANTUS_QUALITY_TO_EDITOR}). The reverse is
 *     information-lossy by construction; the round-trip test only pins that the
 *     15 exact ordinals survive edit -> libcantus -> edit unchanged.
 *
 * Pure module; no exceptions are thrown for unknown ordinals (they fall back to
 * major), so callers never need to guard estimator output.
 */

import { type ChordData, type ChordQuality, type ChordSpan, makeChord } from '@libraz/libcantus';
import { type EditorChordSymbol, normalizedChordExtensions } from '@/project/chords';

/**
 * Audio-domain quality ordinal -> libcantus quality. Ordinals map to an exact
 * libcantus quality where one exists. Ordinal 11 (`m(add9)`, a minor triad plus
 * a 9th with no 7th) has no exact libcantus member and degrades to `min`; its
 * added 9th is preserved on the editor side by the symbol's `extensions`.
 */
const AUDIO_QUALITY_TO_LIBCANTUS: Readonly<Record<number, ChordQuality>> = {
  0: 'maj',
  1: 'min',
  2: 'dim',
  3: 'aug',
  4: 'dom7',
  5: 'maj7',
  6: 'min7',
  7: 'sus2',
  8: 'sus4',
  10: 'add9',
  11: 'min', // m(add9) degrades to a minor triad
  12: 'dim7',
  13: 'm7b5',
  14: 'maj9',
  15: 'dom9',
};

/** Known editor base-quality + normalized-extension combinations. */
const EDITOR_EXTENSIONS_TO_LIBCANTUS: Readonly<Record<string, ChordQuality>> = {
  '0:5': 'add11',
  '0:6': 'majb5',
  '0:9': '6',
  '0:2,9': '6/9',
  '1:9': 'min6',
  '1:11': 'minMaj7',
  '3:10': 'aug7',
  '3:11': 'augMaj7',
  '4:1': '7b9',
  '4:3': '7#9',
  '4:5': '11',
  '4:6': '7#11',
  '4:8': '7b13',
  '4:9': '13',
  '6:2': 'min9',
};

/** Editor-side ordinal plus optional color-tone extensions (semitone offsets). */
export interface EditorQuality {
  quality: number;
  extensions?: number[];
}

/**
 * libcantus quality -> editor ordinal (+ extensions). Qualities the editor
 * cannot name directly degrade to a base ordinal carrying the extra chord tones
 * as `extensions` semitone offsets (9 = 2, 11 = 5, 13 = 9, b9 = 1, #9 = 3,
 * #11 = 6, b13 = 8, maj7-over-triad = 11, dom7-over-aug = 10).
 */
const LIBCANTUS_QUALITY_TO_EDITOR: Readonly<Record<ChordQuality, EditorQuality>> = {
  maj: { quality: 0 },
  min: { quality: 1 },
  dim: { quality: 2 },
  aug: { quality: 3 },
  dom7: { quality: 4 },
  maj7: { quality: 5 },
  min7: { quality: 6 },
  sus2: { quality: 7 },
  sus4: { quality: 8 },
  add9: { quality: 10 },
  dim7: { quality: 12 },
  m7b5: { quality: 13 },
  maj9: { quality: 14 },
  dom9: { quality: 15 },
  minMaj7: { quality: 1, extensions: [11] },
  aug7: { quality: 3, extensions: [10] },
  augMaj7: { quality: 3, extensions: [11] },
  majb5: { quality: 0, extensions: [6] },
  '6': { quality: 0, extensions: [9] },
  min6: { quality: 1, extensions: [9] },
  '6/9': { quality: 0, extensions: [9, 2] },
  add11: { quality: 0, extensions: [5] },
  min9: { quality: 6, extensions: [2] },
  '7b9': { quality: 4, extensions: [1] },
  '7#9': { quality: 4, extensions: [3] },
  '7#11': { quality: 4, extensions: [6] },
  '7b13': { quality: 4, extensions: [8] },
  '11': { quality: 4, extensions: [5] },
  '13': { quality: 4, extensions: [9] },
  '5': { quality: 0 }, // power chord: no third to name, nearest is a bare major
};

/** Maps an editor quality ordinal to the nearest libcantus quality (default major). */
export function audioQualityToLibcantus(quality: number): ChordQuality {
  return AUDIO_QUALITY_TO_LIBCANTUS[quality] ?? 'maj';
}

/** Maps a libcantus quality to the editor ordinal (+ any degraded extensions). */
export function libcantusQualityToEditor(quality: ChordQuality): EditorQuality {
  return LIBCANTUS_QUALITY_TO_EDITOR[quality] ?? { quality: 0 };
}

/** Exact libcantus quality for a known base-plus-extension combination. */
function extensionQuality(symbol: EditorChordSymbol): ChordQuality | undefined {
  const extensions = normalizedChordExtensions(symbol);
  if (extensions.length === 0) return undefined;
  return EDITOR_EXTENSIONS_TO_LIBCANTUS[`${symbol.quality}:${extensions.join(',')}`];
}

/** Conventional compound interval for a free extension pitch class. */
function compoundExtensionInterval(pc: number): number {
  return pc >= 1 && pc <= 9 ? pc + 12 : pc;
}

/** Appends free extensions without duplicating an intrinsic pitch class. */
function appendExtensionIntervals(
  intervals: number[],
  extensions: ReadonlyArray<number>,
): number[] {
  const pitchClasses = new Set(intervals.map((interval) => ((interval % 12) + 12) % 12));
  const out = [...intervals];
  for (const extension of extensions) {
    if (pitchClasses.has(extension)) continue;
    pitchClasses.add(extension);
    out.push(compoundExtensionInterval(extension));
  }
  return out;
}

/**
 * Builds a libcantus chord from an editor symbol. Known extension combinations
 * use their exact quality; free combinations retain an explicit interval set.
 */
export function editorChordToChord(symbol: EditorChordSymbol): ChordData {
  const rootPc = ((symbol.rootPc % 12) + 12) % 12;
  const exactExtensionQuality = extensionQuality(symbol);
  const quality = exactExtensionQuality ?? audioQualityToLibcantus(symbol.quality);
  const bassPc =
    symbol.bassPc === undefined || symbol.bassPc === rootPc
      ? undefined
      : ((symbol.bassPc % 12) + 12) % 12;
  const chord = makeChord(rootPc, quality, bassPc);
  if (exactExtensionQuality !== undefined) return chord;
  const extensions = normalizedChordExtensions(symbol);
  // Audio quality 11 is intrinsically m(add9), but libcantus has no exact
  // quality for a minor triad with a ninth and no seventh.
  if (symbol.quality === 11) extensions.push(2);
  chord.intervals = appendExtensionIntervals(chord.intervals, extensions);
  return chord;
}

/** Places an editor symbol on a beat as a libcantus {@link ChordSpan}. */
export function editorChordToChordSpan(symbol: EditorChordSymbol, startBeat: number): ChordSpan {
  const rootPc = ((symbol.rootPc % 12) + 12) % 12;
  const span: ChordSpan = {
    rootPc,
    quality: extensionQuality(symbol) ?? audioQualityToLibcantus(symbol.quality),
    startBeat,
  };
  if (symbol.bassPc !== undefined && symbol.bassPc !== rootPc) {
    span.bassPc = ((symbol.bassPc % 12) + 12) % 12;
  }
  return span;
}

/**
 * Converts a libcantus chord span back to an editor symbol over a PPQ region.
 * Quality degrades per {@link libcantusQualityToEditor}; the span's beat is not
 * used for the region (callers supply absolute PPQ bounds).
 */
export function chordSpanToEditorChord(
  span: ChordSpan,
  startPpq: number,
  endPpq: number,
): EditorChordSymbol {
  const mapped = libcantusQualityToEditor(span.quality);
  const rootPc = ((span.rootPc % 12) + 12) % 12;
  const symbol: EditorChordSymbol = {
    startPpq,
    endPpq,
    rootPc,
    quality: mapped.quality,
  };
  if (span.bassPc !== undefined && ((span.bassPc % 12) + 12) % 12 !== rootPc) {
    symbol.bassPc = ((span.bassPc % 12) + 12) % 12;
  }
  if (mapped.extensions !== undefined && mapped.extensions.length > 0) {
    symbol.extensions = [...mapped.extensions];
  }
  return symbol;
}
