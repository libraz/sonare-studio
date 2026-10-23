/** Shared eligibility contract for every clip-split entry point. */

/** Stable command-layer error used when native split cannot accept a loop clip. */
export const LOOP_CLIP_SPLIT_ERROR = 'Turn Loop off before splitting this clip.';

/** Minimal clip shape needed to decide whether a timeline split is valid. */
export interface ClipSplitCandidate {
  startPpq: number;
  lengthPpq: number;
  loopEnabled?: boolean;
}

/** Why a split cannot run at the requested position. */
export type ClipSplitBlockReason = 'loop' | 'position';

/** Returns the native-compatible split blocker, or null when splitting is safe. */
export function clipSplitBlockReason(
  clip: ClipSplitCandidate,
  splitPpq: number,
): ClipSplitBlockReason | null {
  if (clip.loopEnabled === true) return 'loop';
  if (
    !Number.isFinite(splitPpq) ||
    splitPpq <= clip.startPpq ||
    splitPpq >= clip.startPpq + clip.lengthPpq
  ) {
    return 'position';
  }
  return null;
}

/**
 * Picks the clip a split at the playhead acts on: the active clip when the
 * playhead is strictly inside it, otherwise the first clip on the active track
 * under the playhead.
 */
export function resolveClipSplitTarget<T extends ClipSplitCandidate & { trackId: number }>(
  clips: ReadonlyArray<T>,
  activeClip: T | null,
  activeTrackId: number,
  ppq: number,
): T | null {
  const inside = (clip: ClipSplitCandidate): boolean =>
    ppq > clip.startPpq && ppq < clip.startPpq + clip.lengthPpq;
  if (activeClip && inside(activeClip)) return activeClip;
  return clips.find((clip) => clip.trackId === activeTrackId && inside(clip)) ?? null;
}
