import { deleteAsset } from './assets';

/** Raised when an operation tries to lease an asset already being deleted. */
export class AssetDeletionInProgressError extends Error {
  constructor(readonly assetId: string) {
    super(`Audio asset "${assetId}" is being deleted`);
    this.name = 'AssetDeletionInProgressError';
  }
}

export interface AudioAssetLease {
  /** Replaces the protected id set without releasing the lease object. */
  update(assetIds: Iterable<string>): void;
  /** Releases every protected id. Idempotent. */
  release(): void;
}

const leaseCounts = new Map<string, number>();
const deletingIds = new Set<string>();

function increment(assetId: string): void {
  if (deletingIds.has(assetId)) throw new AssetDeletionInProgressError(assetId);
  leaseCounts.set(assetId, (leaseCounts.get(assetId) ?? 0) + 1);
}

function decrement(assetId: string): void {
  const next = (leaseCounts.get(assetId) ?? 0) - 1;
  if (next > 0) leaseCounts.set(assetId, next);
  else leaseCounts.delete(assetId);
}

/** Acquires a mutable lease over one or more audio asset ids. */
export function leaseAudioAssets(assetIds: Iterable<string>): AudioAssetLease {
  let held = new Set(assetIds);
  const acquired: string[] = [];
  try {
    for (const assetId of held) {
      increment(assetId);
      acquired.push(assetId);
    }
  } catch (error) {
    for (const assetId of acquired) decrement(assetId);
    throw error;
  }
  let released = false;
  return {
    update(nextIds): void {
      if (released) return;
      const next = new Set(nextIds);
      const additions = [...next].filter((assetId) => !held.has(assetId));
      for (const assetId of additions) {
        if (deletingIds.has(assetId)) throw new AssetDeletionInProgressError(assetId);
      }
      for (const assetId of additions) increment(assetId);
      for (const assetId of held) {
        if (!next.has(assetId)) decrement(assetId);
      }
      held = next;
    },
    release(): void {
      if (released) return;
      released = true;
      for (const assetId of held) decrement(assetId);
      held.clear();
    },
  };
}

/** Snapshot of every asset id protected by at least one live lease. */
export function leasedAudioAssetIds(): Set<string> {
  return new Set(leaseCounts.keys());
}

export function isAudioAssetLeased(assetId: string): boolean {
  return leaseCounts.has(assetId);
}

/**
 * Deletes under an exclusive id guard, checking dynamic references and leases
 * immediately before the underlying OPFS mutation.
 */
export async function deleteAudioAssetGuarded(
  assetId: string,
  isReferenced: () => boolean | Promise<boolean>,
): Promise<boolean> {
  if (deletingIds.has(assetId)) return false;
  deletingIds.add(assetId);
  try {
    if (isAudioAssetLeased(assetId) || (await isReferenced()) || isAudioAssetLeased(assetId)) {
      return false;
    }
    await deleteAsset(assetId);
    return true;
  } finally {
    deletingIds.delete(assetId);
  }
}

/** Test-only reset for the process-global registry. */
export function clearAudioAssetLeases(): void {
  leaseCounts.clear();
  deletingIds.clear();
}
