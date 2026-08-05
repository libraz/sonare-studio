/** Pure row filtering for collapsed arrangement group tracks. */

/** Minimal group relation needed to decide whether a row is visible. */
export interface GroupRowTrack {
  id: number;
  groupId?: number;
}

/**
 * Returns rows visible after collapsed group members are hidden. Group tracks
 * themselves always remain visible, preserving the expansion affordance.
 */
export function visibleGroupRows<T extends GroupRowTrack>(
  tracks: readonly T[],
  collapsedGroupIds: ReadonlySet<number>,
): T[] {
  return tracks.filter(
    (track) => track.groupId === undefined || !collapsedGroupIds.has(track.groupId),
  );
}
