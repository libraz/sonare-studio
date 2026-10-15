/**
 * Lane occupancy for clip placement.
 *
 * A track holds one lane of clips that may abut but never overlap, and the
 * Project refuses any edit that breaks that. Every command that places,
 * moves, replaces or records clips decides collisions here, with one
 * tolerance, and runs its destructive steps in the order the engine accepts.
 */

import { getProject, useProjectStore } from '../store';
import type { EditorClip } from '../types';
import { moveClipWithin, removeClipWithin, splitClipWithin } from './clips-internal';
import type { AtomicProjectEdit } from './history';

/** Tolerance below which two clip edges count as touching. */
export const CLIP_LANE_EPSILON = 1e-9;

/** True when two ranges share more than a boundary (abutting ranges do not collide). */
export function clipRangesCollide(
  aStartPpq: number,
  aLengthPpq: number,
  bStartPpq: number,
  bLengthPpq: number,
): boolean {
  return (
    aStartPpq < bStartPpq + bLengthPpq - CLIP_LANE_EPSILON &&
    bStartPpq < aStartPpq + aLengthPpq - CLIP_LANE_EPSILON
  );
}

/** Clips on a track whose range collides with the given range. */
export function clipsCollidingWith(
  clips: readonly EditorClip[],
  trackId: number,
  startPpq: number,
  lengthPpq: number,
): EditorClip[] {
  return clips.filter(
    (clip) =>
      clip.trackId === trackId &&
      clipRangesCollide(clip.startPpq, clip.lengthPpq, startPpq, lengthPpq),
  );
}

/**
 * The free span of a track's lane around a timeline point, bounded by the
 * neighbouring clips; null when a clip covers the point.
 */
export function laneGapAround(
  clips: readonly EditorClip[],
  trackId: number,
  ppq: number,
): { startPpq: number; endPpq: number } | null {
  let startPpq = 0;
  let endPpq = Number.POSITIVE_INFINITY;
  for (const clip of clips) {
    if (clip.trackId !== trackId) continue;
    const clipEnd = clip.startPpq + clip.lengthPpq;
    if (clipEnd <= ppq + CLIP_LANE_EPSILON) startPpq = Math.max(startPpq, clipEnd);
    else if (clip.startPpq > ppq + CLIP_LANE_EPSILON) endPpq = Math.min(endPpq, clip.startPpq);
    else return null;
  }
  return { startPpq, endPpq };
}

/**
 * Keeps ordinary edits from creating new overlaps after a crossfade enables
 * the native project's global overlap policy. Existing crossfade pairs may
 * still be moved or trimmed together.
 */
export function assertNoNewClipOverlaps(
  clips: readonly EditorClip[],
  changes: ReadonlyArray<{ clipId: number; startPpq: number; lengthPpq: number; trackId: number }>,
): void {
  const byId = new Map(changes.map((change) => [change.clipId, change]));
  for (let i = 0; i < clips.length; i += 1) {
    const a = clips[i];
    const nextA = byId.get(a.id);
    for (let j = i + 1; j < clips.length; j += 1) {
      const b = clips[j];
      const nextB = byId.get(b.id);
      if (!nextA && !nextB) continue;
      const aTrack = nextA?.trackId ?? a.trackId;
      const bTrack = nextB?.trackId ?? b.trackId;
      if (aTrack !== bTrack) continue;
      if (
        !clipRangesCollide(
          nextA?.startPpq ?? a.startPpq,
          nextA?.lengthPpq ?? a.lengthPpq,
          nextB?.startPpq ?? b.startPpq,
          nextB?.lengthPpq ?? b.lengthPpq,
        )
      )
        continue;
      if (
        a.trackId === b.trackId &&
        clipRangesCollide(a.startPpq, a.lengthPpq, b.startPpq, b.lengthPpq)
      )
        continue;
      throw new RangeError(`Clip edit would overlap clip ${nextA ? b.id : a.id}`);
    }
  }
}

/** One clip relocation handled by {@link moveClipsWithin}. */
export interface LaneMove {
  clipId: number;
  startPpq: number;
  /** Destination track; omitted to stay on the current one. */
  trackId?: number;
}

/**
 * Applies several clip moves in an order where no step lands on a clip that
 * has yet to move, so a group shifted in either direction never collides
 * with itself. A set of moves that block each other (a swap) is broken by
 * parking one clip past the end of its lane for the moment.
 *
 * Positions are read from the mirror, which must reflect the clips as they
 * stand when the first move runs.
 */
export function moveClipsWithin(edit: AtomicProjectEdit, moves: ReadonlyArray<LaneMove>): void {
  const placement = new Map(
    useProjectStore().clips.map((clip) => [
      clip.id,
      { trackId: clip.trackId, startPpq: clip.startPpq, lengthPpq: clip.lengthPpq },
    ]),
  );
  const current = (clipId: number) => {
    const placed = placement.get(clipId);
    if (placed === undefined) throw new RangeError(`Unknown clip id: ${clipId}`);
    return placed;
  };
  // Rightward moves go latest first and the rest earliest first, which is
  // collision-free for the common case; the scan below only handles the rest.
  const pending = [...moves].sort((a, b) => {
    const aRight = a.startPpq > current(a.clipId).startPpq;
    const bRight = b.startPpq > current(b.clipId).startPpq;
    if (aRight !== bRight) return aRight ? 1 : -1;
    const delta = current(a.clipId).startPpq - current(b.clipId).startPpq;
    return aRight ? -delta : delta;
  });
  const isBlocked = (move: LaneMove): boolean => {
    const placed = current(move.clipId);
    const trackId = move.trackId ?? placed.trackId;
    return pending.some((other) => {
      if (other.clipId === move.clipId) return false;
      const at = current(other.clipId);
      return (
        at.trackId === trackId &&
        clipRangesCollide(move.startPpq, placed.lengthPpq, at.startPpq, at.lengthPpq)
      );
    });
  };
  const apply = (move: LaneMove): void => {
    moveClipWithin(edit, move.clipId, move.startPpq, move.trackId);
    const placed = current(move.clipId);
    placed.startPpq = move.startPpq;
    if (move.trackId !== undefined) placed.trackId = move.trackId;
  };
  const parked = new Set<number>();
  while (pending.length > 0) {
    const readyIndex = pending.findIndex((move) => !isBlocked(move));
    if (readyIndex >= 0) {
      apply(pending.splice(readyIndex, 1)[0]);
      continue;
    }
    const stuck = pending.find((move) => !parked.has(move.clipId));
    if (stuck === undefined) {
      // Nothing left to park: let the engine judge the remaining layout.
      apply(pending.splice(0, 1)[0]);
      continue;
    }
    parked.add(stuck.clipId);
    const placed = current(stuck.clipId);
    let laneEnd = 0;
    for (const entry of placement.values()) {
      if (entry.trackId === placed.trackId) {
        laneEnd = Math.max(laneEnd, entry.startPpq + entry.lengthPpq);
      }
    }
    moveClipWithin(edit, stuck.clipId, laneEnd + placed.lengthPpq);
    placed.startPpq = laneEnd + placed.lengthPpq;
  }
}

/**
 * Replaces clips with one built from their material. The sources are removed
 * first, so the replacement never coexists with them in the lane; the caller
 * must have captured whatever it needs from them beforehand. Runs inside the
 * caller's atomic transaction, so a failure restores the sources.
 *
 * @param sourceIds Clips to remove.
 * @param create Adds the replacement and returns its result.
 */
export function replaceClipsWithin<T>(
  edit: AtomicProjectEdit,
  sourceIds: Iterable<number>,
  create: () => T,
): T {
  for (const id of sourceIds) removeClipWithin(edit, id);
  return create();
}

/**
 * Makes a range of a track's lane empty: every clip crossing it is split at
 * the range edges and the middle part removed, leaving the material outside
 * untouched. Runs inside the caller's atomic transaction.
 */
export function clearLaneRangeWithin(
  edit: AtomicProjectEdit,
  trackId: number,
  startPpq: number,
  endPpq: number,
): void {
  const store = useProjectStore();
  // Snapshot ids first: splitting inserts right-hand clips into the mirror,
  // but each original clip is handled independently.
  const crossing = clipsCollidingWith(store.clips, trackId, startPpq, endPpq - startPpq).map(
    (clip) => clip.id,
  );
  for (const clipId of crossing) {
    const source = store.clips.find((clip) => clip.id === clipId);
    if (source === undefined) continue;
    const overlapStart = Math.max(startPpq, source.startPpq);
    const overlapEnd = Math.min(endPpq, source.startPpq + source.lengthPpq);
    let middleId = clipId;
    if (source.startPpq < overlapStart - CLIP_LANE_EPSILON)
      middleId = splitClipWithin(edit, middleId, overlapStart);
    const middle = store.clips.find((clip) => clip.id === middleId);
    if (middle === undefined) continue;
    if (middle.startPpq + middle.lengthPpq > overlapEnd + CLIP_LANE_EPSILON) {
      splitClipWithin(edit, middleId, overlapEnd);
    }
    removeClipWithin(edit, middleId);
  }
}

/**
 * Makes room for a recorded take: under the disallow overlap policy the
 * recorded range is cleared like {@link clearLaneRangeWithin}; a project that
 * allows overlap layers the take over existing clips instead.
 */
export function makeRoomForRecordingWithin(
  edit: AtomicProjectEdit,
  trackId: number,
  startPpq: number,
  endPpq: number,
): void {
  if (getProject().getOverlapPolicy() !== 0) return;
  clearLaneRangeWithin(edit, trackId, startPpq, endPpq);
}
