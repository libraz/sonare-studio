/**
 * Secondary-dominant insertion command: adds a V7/x chord immediately before a
 * chord on the track by splitting the region that abuts it, rather than
 * shifting later chords — shifting would desync the chord track from the
 * clips it annotates.
 */

import { secondaryDominantOf } from '@/compose/secondary-dominant';
import type { EditorChordSymbol } from '../chords';
import { useProjectStore } from '../store';
import { setProjectChords } from './chords';

/** Minimum PPQ length either side of a split must keep. */
const MIN_SPLIT_PPQ = 1;

function insertAt(
  chords: ReadonlyArray<EditorChordSymbol>,
  index: number,
  entry: EditorChordSymbol,
): EditorChordSymbol[] {
  const list = chords.map((chord) => ({ ...chord }));
  list.splice(index, 0, entry);
  return list;
}

/**
 * Inserts the secondary dominant of the chord at `index` immediately before it.
 *
 * The new chord's region comes from whichever region abuts the target on its
 * left: a pre-existing gap is filled entirely; otherwise the second half of
 * the preceding chord's region is donated (or, for the first chord, the first
 * half of its own region). Total timeline coverage is unchanged —
 * nothing after the target moves.
 *
 * @returns True if a chord was inserted; false when the abutting region is
 *   too short to split (an out-of-range index is also a no-op).
 */
export function insertSecondaryDominantBefore(index: number): boolean {
  const store = useProjectStore();
  const target = store.chords[index];
  if (!target) return false;
  const preceding = index > 0 ? store.chords[index - 1] : undefined;

  if (preceding && preceding.endPpq < target.startPpq) {
    setProjectChords(
      insertAt(
        store.chords,
        index,
        secondaryDominantOf(target, { startPpq: preceding.endPpq, endPpq: target.startPpq }),
      ),
    );
    return true;
  }

  const donorStart = preceding ? preceding.startPpq : target.startPpq;
  const donorEnd = preceding ? Math.min(preceding.endPpq, target.startPpq) : target.endPpq;
  const half = Math.floor((donorEnd - donorStart) / 2);
  if (half < MIN_SPLIT_PPQ || donorEnd - donorStart - half < MIN_SPLIT_PPQ) return false;
  const splitAt = donorEnd - half;

  const list = store.chords.map((chord) => ({ ...chord }));
  // With a preceding chord, donate its second half (ends right at the target).
  // Without one, donate the target's own first half (the target keeps the rest).
  const insertRegion = preceding
    ? { startPpq: splitAt, endPpq: donorEnd }
    : { startPpq: donorStart, endPpq: splitAt };
  if (preceding) list[index - 1] = { ...list[index - 1], endPpq: splitAt };
  else list[index] = { ...list[index], startPpq: splitAt };
  list.splice(index, 0, secondaryDominantOf(target, insertRegion));
  setProjectChords(list);
  return true;
}
