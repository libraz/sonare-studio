/**
 * The overlap test the native project's 'disallow' policy applies: two clips
 * on one track overlap when either starts strictly before the other ends, with
 * no tolerance. Load and the post-edit policy derivation both decide by it.
 */

/** Placement fields the overlap test reads. */
export interface LaneClipPlacement {
  trackId: number;
  startPpq: number;
  lengthPpq: number;
}

/** Returns true when any track holds two clips that overlap. */
export function lanesHoldOverlap(clips: Iterable<LaneClipPlacement>): boolean {
  const byTrack = new Map<number, LaneClipPlacement[]>();
  for (const clip of clips) {
    const lane = byTrack.get(clip.trackId);
    if (lane) lane.push(clip);
    else byTrack.set(clip.trackId, [clip]);
  }
  for (const lane of byTrack.values()) {
    lane.sort((a, b) => a.startPpq - b.startPpq);
    let latestEnd = Number.NEGATIVE_INFINITY;
    for (const clip of lane) {
      if (clip.startPpq < latestEnd) return true;
      latestEnd = Math.max(latestEnd, clip.startPpq + clip.lengthPpq);
    }
  }
  return false;
}
