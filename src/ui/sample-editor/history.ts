/**
 * Session-local version history for the sample editor.
 *
 * Assets are content-addressed and immutable: every edit stores a NEW asset,
 * so "history" is just an ordered list of asset ids the user can jump
 * between. Pushing a version while an older one is selected drops the
 * versions after it (undo-branch semantics); the dropped assets themselves
 * stay in the asset store untouched.
 *
 * The state is immutable (every mutation returns a new state object) so it
 * can live in a Vue ref without deep reactivity.
 */

/** One entry of the version list. */
export interface AssetVersion {
  /** Asset id of this version. */
  assetId: string;
  /** Human-readable label (e.g. the operation that produced it). */
  label: string;
}

/** Immutable history state: the version list plus the selected index. */
export interface VersionHistoryState {
  /** All versions, oldest first. */
  readonly versions: ReadonlyArray<AssetVersion>;
  /** Index of the currently selected version. */
  readonly currentIndex: number;
}

/** Creates a history containing only the initial (unedited) version. */
export function createHistory(initial: AssetVersion): VersionHistoryState {
  return { versions: [initial], currentIndex: 0 };
}

/** Returns the currently selected version. */
export function currentVersion(state: VersionHistoryState): AssetVersion {
  return state.versions[state.currentIndex];
}

/**
 * Appends a new version after the current one and selects it, dropping any
 * versions that followed (they remain in the asset store). Pushing the asset
 * id that is already current is a no-op (content-addressed ids make this the
 * "edit changed nothing" case) and returns the same state object.
 */
export function pushVersion(
  state: VersionHistoryState,
  version: AssetVersion,
): VersionHistoryState {
  if (currentVersion(state).assetId === version.assetId) return state;
  const versions = [...state.versions.slice(0, state.currentIndex + 1), version];
  return { versions, currentIndex: versions.length - 1 };
}

/**
 * Selects a version by index (jump back or forward).
 *
 * @throws RangeError when the index is out of bounds.
 */
export function selectVersion(state: VersionHistoryState, index: number): VersionHistoryState {
  if (!Number.isInteger(index) || index < 0 || index >= state.versions.length) {
    throw new RangeError(`No history version at index ${index}`);
  }
  if (index === state.currentIndex) return state;
  return { versions: state.versions, currentIndex: index };
}

/** Name suffix marking assets produced by the sample editor. */
const EDITED_SUFFIX = ' (edited)';

/**
 * Derives the display name for an edited copy of an asset: appends
 * " (edited)" once (names already carrying the suffix are kept as-is).
 */
export function editedAssetName(name: string): string {
  return name.endsWith(EDITED_SUFFIX) ? name : name + EDITED_SUFFIX;
}
