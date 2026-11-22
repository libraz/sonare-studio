/** Tolerance (PPQ) for treating one clip's end as touching the next clip's start. */
const TOUCH_EPSILON_PPQ = 1e-6;

/** The timeline extent of a clip, which is all a run needs. */
interface ClipExtent {
  id: number;
  startPpq: number;
  lengthPpq: number;
}

/**
 * Ids of the run of touching or overlapping clips that contains `clipId`, in
 * start order. Neighbours are compared pairwise in start order, so a gap
 * between two adjacent clips ends the run.
 *
 * @param clips Candidate clips, typically one track's clips of one kind.
 * @param clipId The clip the run must contain.
 * @returns The run's ids, or [] when `clipId` is not among `clips`.
 */
export function touchingClipRunIds(clips: ReadonlyArray<ClipExtent>, clipId: number): number[] {
  const candidates = [...clips].sort((a, b) => a.startPpq - b.startPpq || a.id - b.id);
  const sourceIndex = candidates.findIndex((clip) => clip.id === clipId);
  if (sourceIndex < 0) return [];
  let first = sourceIndex;
  let last = sourceIndex;
  while (first > 0) {
    const prev = candidates[first - 1];
    const current = candidates[first];
    if (prev.startPpq + prev.lengthPpq + TOUCH_EPSILON_PPQ < current.startPpq) break;
    first--;
  }
  while (last < candidates.length - 1) {
    const current = candidates[last];
    const next = candidates[last + 1];
    if (current.startPpq + current.lengthPpq + TOUCH_EPSILON_PPQ < next.startPpq) break;
    last++;
  }
  return candidates.slice(first, last + 1).map((clip) => clip.id);
}
