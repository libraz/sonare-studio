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

/** Whether the target can function as a temporary tonic. */
export function canTonicizeWithSecondaryDominant(target: EditorChordSymbol): boolean {
  // Diminished, half-diminished, diminished-seventh, and augmented chords do
  // not function as temporary tonic targets in this insertion workflow.
  return ![2, 3, 12, 13].includes(target.quality);
}

/** Display label for a secondary dominant, e.g. "V7/V". */
export function secondaryDominantLabel(target: EditorChordSymbol, key: KeyScale): string {
  const roman = chordToRoman(editorChordToChord(target), key);
  // The target is named by scale degree only: quality suffixes and inversion
  // figures belong to the target chord, not to the V7/x function.
  const degree = roman.match(/^[b♭#]?[-+]?([ivIV]+)/)?.[0] ?? roman;
  return `V7/${degree}`;
}
