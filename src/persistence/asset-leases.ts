import { deleteAssetUnlocked } from './assets';
import { withPersistenceMutationLock } from './mutation-lock';

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
const remoteLeaseIds = new Map<string, Set<string>>();
const LEASE_CHANNEL_NAME = 'sonare-studio:audio-asset-leases:v1';
const LEASE_SYNC_MS = 30;
const leaseSessionId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

type LeaseMessage =
  | { type: 'hello'; sessionId: string }
  | { type: 'leases'; sessionId: string; assetIds: string[] }
  | { type: 'closed'; sessionId: string };

const leaseChannel =
  typeof BroadcastChannel === 'function' ? new BroadcastChannel(LEASE_CHANNEL_NAME) : null;

function localLeaseIds(): string[] {
  return [...leaseCounts.keys()].sort();
}

function postLeaseMessage(message: LeaseMessage): void {
  leaseChannel?.postMessage(message);
}

function publishLocalLeases(): void {
  postLeaseMessage({ type: 'leases', sessionId: leaseSessionId, assetIds: localLeaseIds() });
}

leaseChannel?.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data as Partial<LeaseMessage> | null;
  if (!message || typeof message.sessionId !== 'string' || message.sessionId === leaseSessionId)
    return;
  if (message.type === 'hello') {
    publishLocalLeases();
    return;
  }
  if (message.type === 'closed') {
    remoteLeaseIds.delete(message.sessionId);
    return;
  }
  if (
    message.type === 'leases' &&
    Array.isArray(message.assetIds) &&
    message.assetIds.every((assetId) => typeof assetId === 'string')
  ) {
    remoteLeaseIds.set(message.sessionId, new Set(message.assetIds));
  }
});

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pagehide',
    () => postLeaseMessage({ type: 'closed', sessionId: leaseSessionId }),
    { once: true },
  );
}
publishLocalLeases();

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
  publishLocalLeases();
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
      publishLocalLeases();
    },
    release(): void {
      if (released) return;
      released = true;
      for (const assetId of held) decrement(assetId);
      held.clear();
      publishLocalLeases();
    },
  };
}

/** Snapshot of every asset id protected by at least one live lease. */
export function leasedAudioAssetIds(): Set<string> {
  return new Set([
    ...leaseCounts.keys(),
    ...[...remoteLeaseIds.values()].flatMap((assetIds) => [...assetIds]),
  ]);
}

export function isAudioAssetLeased(assetId: string): boolean {
  if (leaseCounts.has(assetId)) return true;
  for (const assetIds of remoteLeaseIds.values()) {
    if (assetIds.has(assetId)) return true;
  }
  return false;
}

/** Requests a fresh lease snapshot from every live tab before destructive GC. */
export async function synchronizeAudioAssetLeases(): Promise<Set<string>> {
  if (!leaseChannel) return leasedAudioAssetIds();
  remoteLeaseIds.clear();
  postLeaseMessage({ type: 'hello', sessionId: leaseSessionId });
  await new Promise<void>((resolve) => setTimeout(resolve, LEASE_SYNC_MS));
  return leasedAudioAssetIds();
}

/**
 * Deletes under an exclusive id guard, checking dynamic references and leases
 * immediately before the underlying OPFS mutation.
 */
export async function deleteAudioAssetGuarded(
  assetId: string,
  isReferenced: () => boolean | Promise<boolean>,
  alreadyLocked = false,
): Promise<boolean> {
  if (deletingIds.has(assetId)) return false;
  deletingIds.add(assetId);
  const remove = async (): Promise<boolean> => {
    try {
      await synchronizeAudioAssetLeases();
      if (isAudioAssetLeased(assetId) || (await isReferenced())) {
        return false;
      }
      await synchronizeAudioAssetLeases();
      if (isAudioAssetLeased(assetId)) {
        return false;
      }
      await deleteAssetUnlocked(assetId);
      return true;
    } finally {
      deletingIds.delete(assetId);
    }
  };
  return alreadyLocked ? remove() : withPersistenceMutationLock(remove);
}

/** Test-only reset for the process-global registry. */
export function clearAudioAssetLeases(): void {
  leaseCounts.clear();
  deletingIds.clear();
  remoteLeaseIds.clear();
  publishLocalLeases();
}
