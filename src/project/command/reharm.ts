/**
 * Reharmonization command: replace one chord on the project chord track with a
 * candidate produced by the reharmony palette ({@link reharmCandidatesFor}).
 *
 * The candidate already carries the source chord's PPQ region, so applying it is
 * a single-symbol swap that rebuilds and commits the whole chord stream through
 * {@link setProjectChords} (one undoable entry). Out-of-range indices are a no-op.
 */

import type { ReharmCandidate } from '@/compose/reharm';
import type { EditorChordSymbol } from '../chords';
import { useProjectStore } from '../store';
import { setProjectChords } from './chords';

/**
 * Replaces the chord at `index` on the chord track with a reharmonization
 * candidate, keeping the region (the candidate is placed over the source span).
 *
 * @param index Position of the target chord in the chord stream.
 * @param candidate The substitute to apply.
 */
export function reharmonizeChord(index: number, candidate: ReharmCandidate): void {
  const store = useProjectStore();
  if (index < 0 || index >= store.chords.length) return;
  const next: EditorChordSymbol = { ...candidate.symbol };
  const list = store.chords.map((chord) => ({ ...chord }));
  list[index] = next;
  setProjectChords(list);
}
