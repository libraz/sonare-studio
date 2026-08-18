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
 *     expresses the quality as a base ordinal plus the `extensions` that colour
 *     it and the `omissions` it does not sound. Naming is asymmetric, but the
 *     tone set is not: every quality in the union comes back sounding exactly
 *     the pitch classes libcantus gives it.
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
  normalizedChordOmissions,
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

/** Drops the intervals whose pitch class the symbol declares silent. */
function removeOmittedIntervals(
  intervals: ReadonlyArray<number>,
  omissions: ReadonlyArray<number>,
): number[] {
  if (omissions.length === 0) return [...intervals];
  const silent = new Set(omissions);
  return intervals.filter((interval) => !silent.has(((interval % 12) + 12) % 12));
}

/**
 * Builds a libcantus chord from an editor symbol. Known extension and omission
 * combinations use their exact quality; free combinations retain an explicit
 * interval set with the omitted tones removed.
 */
export function editorChordToChord(symbol: EditorChordSymbol): ChordData {
  const rootPc = ((symbol.rootPc % 12) + 12) % 12;
  const exactQuality = editorExtensionQuality(symbol.quality, symbol.extensions, symbol.omissions);
  const quality = exactQuality ?? audioQualityToLibcantus(symbol.quality);
  const bassPc =
    symbol.bassPc === undefined || symbol.bassPc === rootPc
      ? undefined
      : ((symbol.bassPc % 12) + 12) % 12;
  const chord = makeChord(rootPc, quality, bassPc);
  if (exactQuality !== undefined) return chord;
  const extensions = normalizedChordExtensions(symbol.quality, symbol.extensions);
  const omissions = normalizedChordOmissions(symbol.quality, symbol.omissions);
  chord.intervals = appendExtensionIntervals(
    removeOmittedIntervals(chord.intervals, omissions),
    extensions,
  );
  return chord;
}

/** Places an editor symbol on a beat as a libcantus {@link ChordSpan}. */
export function editorChordToChordSpan(symbol: EditorChordSymbol, startBeat: number): ChordSpan {
  const rootPc = ((symbol.rootPc % 12) + 12) % 12;
  const span: ChordSpan = {
    rootPc,
    quality:
      editorExtensionQuality(symbol.quality, symbol.extensions, symbol.omissions) ??
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
 * Quality is expressed per {@link libcantusQualityToEditor}; the span's beat is
 * not used for the region (callers supply absolute PPQ bounds).
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
  if (mapped.omissions !== undefined && mapped.omissions.length > 0) {
    symbol.omissions = [...mapped.omissions];
  }
  return symbol;
}
