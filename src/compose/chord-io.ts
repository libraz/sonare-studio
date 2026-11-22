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
 *     the pitch classes libcantus gives it, and a span carrying its own
 *     `intervals` comes back sounding those instead of its quality's.
 *
 * The mapping tables themselves live in src/compose/chord-quality.ts, which
 * also names chords from them; this module owns only the ChordData/ChordSpan
 * shape. The bridge accessors are re-exported here for existing callers.
 *
 * Pure module; no exceptions are thrown for unknown ordinals (they fall back to
 * major), so callers never need to guard estimator output.
 */

import { type ChordData, type ChordSpan, makeChord, spanFromChord } from '@libraz/libcantus';
import {
  audioQualityToLibcantus,
  type EditorQuality,
  editorExtensionQuality,
  libcantusQualityToEditor,
  normalizedChordExtensions,
  normalizedChordOmissions,
} from '@/compose/chord-quality';
import { pitchClassOf } from '@/lib/pitch';
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
  const pitchClasses = new Set(intervals.map((interval) => pitchClassOf(interval)));
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
  return intervals.filter((interval) => !silent.has(pitchClassOf(interval)));
}

/**
 * Builds a libcantus chord from an editor symbol. Known extension and omission
 * combinations use their exact quality; free combinations retain an explicit
 * interval set with the omitted tones removed.
 */
export function editorChordToChord(symbol: EditorChordSymbol): ChordData {
  const rootPc = pitchClassOf(symbol.rootPc);
  const exactQuality = editorExtensionQuality(symbol.quality, symbol.extensions, symbol.omissions);
  const quality = exactQuality ?? audioQualityToLibcantus(symbol.quality);
  const bassPc =
    symbol.bassPc === undefined || symbol.bassPc === rootPc
      ? undefined
      : pitchClassOf(symbol.bassPc);
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

/**
 * Places an editor symbol on a beat as a libcantus {@link ChordSpan}.
 *
 * The span is derived from the chord {@link editorChordToChord} builds so the
 * two exports of one symbol cannot describe different chords: a free extension
 * or omission combination has no exact quality, and its tone set would be lost
 * if the span carried only the nearest quality name.
 */
export function editorChordToChordSpan(symbol: EditorChordSymbol, startBeat: number): ChordSpan {
  return spanFromChord(editorChordToChord(symbol), startBeat);
}

/**
 * The editor base quality plus the extensions and omissions that turn its
 * intrinsic tone set into `intervals`, all in pitch-class space. Added tones
 * are the sounded pitch classes the base quality does not carry; omitted ones
 * are the tones it carries that this chord leaves silent.
 */
function toneSetToEditorQuality(quality: number, intervals: ReadonlyArray<number>): EditorQuality {
  const sounded = new Set(
    intervals
      .filter((interval) => Number.isInteger(interval))
      .map((interval) => pitchClassOf(interval)),
  );
  const silent = Array.from({ length: 12 }, (_, pc) => pc).filter((pc) => !sounded.has(pc));
  return {
    quality,
    extensions: normalizedChordExtensions(quality, [...sounded]),
    omissions: normalizedChordOmissions(quality, silent),
  };
}

/**
 * Converts a libcantus chord span back to an editor symbol over a PPQ region.
 * Quality is expressed per {@link libcantusQualityToEditor}; the span's beat is
 * not used for the region (callers supply absolute PPQ bounds).
 *
 * A span carrying an explicit tone set is read from that set rather than from
 * its quality, because a quality is only the nearest name for such a chord and
 * naming it would add or drop tones the analysis did not find.
 */
export function chordSpanToEditorChord(
  span: ChordSpan,
  startPpq: number,
  endPpq: number,
): EditorChordSymbol {
  const named = libcantusQualityToEditor(span.quality);
  const mapped =
    span.intervals === undefined || span.intervals.length === 0
      ? named
      : toneSetToEditorQuality(named.quality, span.intervals);
  const rootPc = pitchClassOf(span.rootPc);
  const symbol: EditorChordSymbol = {
    startPpq,
    endPpq,
    rootPc,
    quality: mapped.quality,
  };
  if (span.bassPc !== undefined && pitchClassOf(span.bassPc) !== rootPc) {
    symbol.bassPc = pitchClassOf(span.bassPc);
  }
  if (mapped.extensions !== undefined && mapped.extensions.length > 0) {
    symbol.extensions = [...mapped.extensions];
  }
  if (mapped.omissions !== undefined && mapped.omissions.length > 0) {
    symbol.omissions = [...mapped.omissions];
  }
  return symbol;
}
