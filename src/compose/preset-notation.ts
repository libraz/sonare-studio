/**
 * Degree numerals + chord letters for a progression preset, e.g. "1–5–6–4 (C–G–Am–F)".
 *
 * Chord letters come from `generateProgression` itself (one bar per degree, no
 * cycling) rather than a local diatonic lookup, because several presets use
 * borrowed-chord degree codes (8–14) that only `generateProgression`'s internal
 * table resolves correctly — a plain diatonic mapping mislabels them (e.g. a
 * Neapolitan bII read back as a diatonic vi).
 */

import {
  chordToRoman,
  formatChordSymbol,
  generateProgression,
  type KeyScale,
  makeChord,
  type ProgressionPreset,
  type ProgStyle,
} from '@libraz/libcantus';
import { chordPitchClassName } from '@/notation/pitch-spelling';

/** Non-diatonic degree codes used by libcantus's borrowed-chord presets. */
const BORROWED_DEGREE_NOTATION: Readonly<Record<number, string>> = {
  8: '♭VI',
  10: '♭VII',
  12: 'iv',
  13: '♭II',
  14: '#iv°',
};

/** Removes quality/inversion decoration from a library Roman-numeral label. */
function romanDegree(chord: ReturnType<typeof makeChord>, key: KeyScale): string {
  const roman = chordToRoman(chord, key);
  return roman.match(/^[b♭#]?[ivIV]+/)?.[0] ?? roman;
}

export function presetNotation(preset: ProgressionPreset, style: ProgStyle, key: KeyScale): string {
  const spans = generateProgression({
    key,
    style,
    presetId: preset.id,
    bars: preset.degrees.length,
  });
  const degrees = spans
    .map((span, index) => {
      const chord = makeChord(span.rootPc, span.quality, span.bassPc);
      return BORROWED_DEGREE_NOTATION[preset.degrees[index]] ?? romanDegree(chord, key);
    })
    .join('–');
  const chordNames = spans
    .map((span) => {
      const chord = makeChord(span.rootPc, span.quality, span.bassPc);
      // libcantus formats pitch names with its default sharp preference. Keep
      // its quality suffix verbatim while replacing only the root spelling.
      const root = chordPitchClassName(span.rootPc, 0).replace('b', '♭');
      return formatChordSymbol(chord).replace(/^[A-G](?:#|b)?/, root);
    })
    .join('–');
  return `${degrees} (${chordNames})`;
}
