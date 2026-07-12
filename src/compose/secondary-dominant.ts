/**
 * Secondary-dominant insertion for the editor's chord track.
 *
 * The dominant seventh that tonicizes a chord sits a perfect fifth above its
 * root (V7/x) — this computes the root directly from the target chord rather
 * than through libcantus's `secondaryDominant(degree, key)`, which needs a
 * scale degree and would mislabel borrowed/chromatic targets that have no
 * clean diatonic degree.
 */

import { chordToRoman, type KeyScale } from '@libraz/libcantus';
import type { EditorChordSymbol } from '@/project/chords';
import { chordSpanToEditorChord, editorChordToChord } from './chord-io';

/**
 * The secondary-dominant (V7/x) chord that tonicizes `target`, placed over the
 * given region.
 */
export function secondaryDominantOf(
  target: EditorChordSymbol,
  region: { startPpq: number; endPpq: number },
): EditorChordSymbol {
  const rootPc = ((target.rootPc % 12) + 12) % 12;
  return chordSpanToEditorChord(
    { rootPc: (rootPc + 7) % 12, quality: 'dom7', startBeat: 0 },
    region.startPpq,
    region.endPpq,
  );
}

/** Display label for a secondary dominant, e.g. "V7/V". */
export function secondaryDominantLabel(target: EditorChordSymbol, key: KeyScale): string {
  return `V7/${chordToRoman(editorChordToChord(target), key)}`;
}
