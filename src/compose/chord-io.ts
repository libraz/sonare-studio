/**
 * Chord-symbol interchange between the editor's {@link EditorChordSymbol} and
 * libcantus's {@link ChordData}/{@link ChordSpan}.
 *
 * The two sides describe chord quality differently. The editor uses the
 * audio-domain quality ordinal (Major = 0), matching the quality choices in
 * src/project/chords.ts and the wasm annotation encoding — a fixed set of ~15
 * qualities plus a free `extensions` list of semitone offsets. libcantus uses a
 * 40-member string union covering richer qualities (`7#9`, `min6`, `6/9`, ...).
 *
 * Mapping is therefore asymmetric:
 *   - editor -> libcantus promotes known base-plus-extension combinations to
 *     exact quality strings and otherwise carries the extensions in the
 *     returned ChordData interval set.
 *   - libcantus -> editor keeps the exact ordinal when one exists, otherwise
 *     degrades to a base ordinal plus an `extensions` list capturing the color
 *     tones. The reverse is information-lossy by construction; the round-trip
 *     test only pins that the 15 exact ordinals survive edit -> libcantus ->
 *     edit unchanged.
 *
 * The mapping tables themselves live in src/compose/chord-quality.ts, which
 * also names chords from them; this module owns only the ChordData/ChordSpan
 * shape. The bridge accessors are re-exported here for existing callers.
 *
 * Pure module; no exceptions are thrown for unknown ordinals (they fall back to
 * major), so callers never need to guard estimator output.
 */

import { type ChordData, type ChordSpan, makeChord } from '@libraz/libcantus';
import {
  audioQualityToLibcantus,
  type EditorQuality,
  editorExtensionQuality,
  libcantusQualityToEditor,
  normalizedChordExtensions,
} from '@/compose/chord-quality';
import type { EditorChordSymbol } from '@/project/chords';

export { audioQualityToLibcantus, type EditorQuality, libcantusQualityToEditor };

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
  const exactExtensionQuality = editorExtensionQuality(symbol.quality, symbol.extensions);
  const quality = exactExtensionQuality ?? audioQualityToLibcantus(symbol.quality);
  const bassPc =
    symbol.bassPc === undefined || symbol.bassPc === rootPc
      ? undefined
      : ((symbol.bassPc % 12) + 12) % 12;
  const chord = makeChord(rootPc, quality, bassPc);
  if (exactExtensionQuality !== undefined) return chord;
  const extensions = normalizedChordExtensions(symbol.quality, symbol.extensions);
  chord.intervals = appendExtensionIntervals(chord.intervals, extensions);
  return chord;
}

/** Places an editor symbol on a beat as a libcantus {@link ChordSpan}. */
export function editorChordToChordSpan(symbol: EditorChordSymbol, startBeat: number): ChordSpan {
  const rootPc = ((symbol.rootPc % 12) + 12) % 12;
  const span: ChordSpan = {
    rootPc,
    quality:
      editorExtensionQuality(symbol.quality, symbol.extensions) ??
      audioQualityToLibcantus(symbol.quality),
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
