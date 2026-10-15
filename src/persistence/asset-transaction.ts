import { deleteAudioAssetsGuarded, leaseAudioAssets } from './asset-leases';
import { type AudioAssetMeta, type SaveAssetInput, saveAssetWithStatus } from './assets';

export interface AudioAssetTransaction {
  /** Saves and leases one immutable asset until commit or rollback. */
  save(
    input: SaveAssetInput,
    audio: Float32Array | ReadonlyArray<Float32Array>,
  ): Promise<AudioAssetMeta>;
  /** Publishes the caller's project/history commit and releases all leases. */
  commit(): void;
  /** Removes newly-created, still-unreferenced assets and releases all leases. */
  rollback(isReferenced?: (assetId: string) => boolean | Promise<boolean>): Promise<void>;
}

/**
 * Creates the shared save→project/history transaction boundary. Asset pairs
 * are published by the store first, but remain leased until the caller's
 * synchronous project command succeeds. Failure rolls back only content this
 * transaction created; deduplicated pre-existing content is never deleted.
 */
export function createAudioAssetTransaction(): AudioAssetTransaction {
  const lease = leaseAudioAssets([]);
  const heldIds = new Set<string>();
  const createdIds = new Set<string>();
  let finished = false;

  return {
    async save(input, audio): Promise<AudioAssetMeta> {
      if (finished) throw new Error('Audio asset transaction is already finished');
      const callerOnIdResolved = input.onIdResolved;
      const saved = await saveAssetWithStatus(
        {
          ...input,
          onIdResolved: (assetId) => {
            heldIds.add(assetId);
            lease.update(heldIds);
            callerOnIdResolved?.(assetId);
          },
        },
        audio,
      );
      if (saved.created) createdIds.add(saved.meta.id);
      return saved.meta;
    },

    commit(): void {
      if (finished) return;
      finished = true;
      lease.release();
    },

    async rollback(isReferenced = () => false): Promise<void> {
      if (finished) return;
      finished = true;
      lease.release();
      await deleteAudioAssetsGuarded([...createdIds].reverse(), isReferenced);
    },
  };
}
