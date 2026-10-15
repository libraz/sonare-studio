/**
 * Shared audio-asset reference collection for UI guards and persistence.
 *
 * Audio assets can be held by the visible clip, by inactive comp takes, or by
 * a frozen track render. All deletion/export/GC paths should walk the same
 * shapes so a hidden reference cannot be treated as unused media.
 */

/** Minimal clip shape that can reference audio assets. */
export interface AssetReferenceClip {
  /** Active audio asset id, if any. */
  assetId?: string;
  /** Alternative cycle-recording takes, each holding its own asset. */
  takes?: ReadonlyArray<{ assetId?: string }>;
}

/** Minimal track shape that can reference audio assets. */
export interface AssetReferenceTrack {
  /** Frozen render, holding the baked audio asset while the track is frozen. */
  frozen?: { assetId?: string };
}

/** Collects asset ids from clips, inactive takes and frozen track renders. */
export function collectReferencedAudioAssetIds(
  clips: Iterable<AssetReferenceClip>,
  tracks: Iterable<AssetReferenceTrack> = [],
): Set<string> {
  const ids = new Set<string>();
  for (const clip of clips) {
    if (clip.assetId) ids.add(clip.assetId);
    for (const take of clip.takes ?? []) {
      if (take.assetId) ids.add(take.assetId);
    }
  }
  for (const track of tracks) {
    if (track.frozen?.assetId) ids.add(track.frozen.assetId);
  }
  return ids;
}

/**
 * Builds a rollback guard over the live project mirror. The reference set is
 * collected on the first check (the point of rollback) and reused for every
 * asset the rollback considers.
 */
export function createAssetReferenceGuard(store: {
  clips: Iterable<AssetReferenceClip>;
  tracks: Iterable<AssetReferenceTrack>;
}): (assetId: string) => boolean {
  let referenced: Set<string> | undefined;
  return (assetId) => {
    referenced ??= collectReferencedAudioAssetIds(store.clips, store.tracks);
    return referenced.has(assetId);
  };
}
