/**
 * Secondary-dominant insertion for the editor's chord track.
 *
 * The dominant seventh that tonicizes a chord sits a perfect fifth above its
 * root (V7/x), computed here directly from the target chord.
 *
 * libcantus's `secondaryDominantOf` answers the same question and agrees on
 * every chord quality at every root, but what it adds over the fifth is a root
 * spelling carried over from the target — and an editor chord symbol is a bare
 * pitch class with nowhere to put one. Delegating would therefore buy nothing
 * and would route a total function through a conversion that throws.
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
