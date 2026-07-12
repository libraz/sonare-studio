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
  formatChordSymbol,
  generateProgression,
  type KeyScale,
  makeChord,
  type ProgressionPreset,
  type ProgStyle,
} from '@libraz/libcantus';

export function presetNotation(preset: ProgressionPreset, style: ProgStyle, key: KeyScale): string {
  const degrees = preset.degrees.map((degree) => degree + 1).join('–');
  const spans = generateProgression({
    key,
    style,
    presetId: preset.id,
    bars: preset.degrees.length,
  });
  const chordNames = spans
    .map((span) => formatChordSymbol(makeChord(span.rootPc, span.quality, span.bassPc)))
    .join('–');
  return `${degrees} (${chordNames})`;
}
