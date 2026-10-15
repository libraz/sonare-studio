import { deleteFontUnlocked } from '@/project/fonts';
import { deleteAssetUnlocked } from './assets';
import { createRandomId, isStringArray } from './fs-utils';
import { withPersistenceMutationLock } from './mutation-lock';

/** Raised when an operation tries to lease an asset already being deleted. */
export class AssetDeletionInProgressError extends Error {
  constructor(readonly assetId: string) {
    super(`Audio asset "${assetId}" is being deleted`);
    this.name = 'AssetDeletionInProgressError';
  }
}

/** Raised when an operation tries to lease a SoundFont already being deleted. */
export class FontDeletionInProgressError extends Error {
  constructor(readonly fontId: string) {
    super(`SoundFont "${fontId}" is being deleted`);
    this.name = 'FontDeletionInProgressError';
  }
}

/** A mutable lease over a set of media ids. */
export interface MediaLease {
  /** Replaces the protected id set without releasing the lease object. */
  update(ids: Iterable<string>): void;
  /** Releases every protected id. Idempotent. */
  release(): void;
}

export type AudioAssetLease = MediaLease;

/** Mutable SoundFont lease (same contract as {@link AudioAssetLease}). */
export type FontLease = MediaLease;

interface RemoteLeaseSnapshot {
  ids: Set<string>;
  expiresAt: number;
}

/**
 * Lease and deletion state of one media kind. Audio assets and SoundFonts
 * share one channel and message but are tracked independently.
 */
interface MediaLeaseStore {
  counts: Map<string, number>;
  deleting: Set<string>;
  remoteLeases: Map<string, RemoteLeaseSnapshot>;
  remoteDeleting: Map<string, number>;
  deletionInProgress(id: string): Error;
  deleteUnlocked(id: string): Promise<void>;
  publishDeleteIntent(ids: string[]): void;
  publishDeleteComplete(ids: string[]): void;
}

const LEASE_CHANNEL_NAME = 'sonare-studio:audio-asset-leases:v1';
// Give a backgrounded peer a realistic window to service the BroadcastChannel
// message. More importantly, its last advertised lease remains authoritative
// if it does not answer this particular sync request.
const LEASE_SYNC_MS = 1000;
/** Unknown peers still get a real BroadcastChannel scheduling window. */
const INITIAL_LEASE_SYNC_MS = 100;
/** A crashed tab's lease eventually expires; active tabs refresh on every hello. */
const REMOTE_LEASE_TTL_MS = 5 * 60 * 1000;
const LEASE_HEARTBEAT_MS = 60 * 1000;
const leaseSessionId = createRandomId();

type LeaseMessage =
  | { type: 'hello'; sessionId: string }
  | { type: 'leases'; sessionId: string; assetIds: string[]; fontIds?: string[] }
  | { type: 'delete-intent'; sessionId: string; assetIds: string[]; fontIds: string[] }
  | { type: 'delete-complete'; sessionId: string; assetIds: string[]; fontIds: string[] }
  | { type: 'closed'; sessionId: string };

const leaseChannel =
  typeof BroadcastChannel === 'function' ? new BroadcastChannel(LEASE_CHANNEL_NAME) : null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function postLeaseMessage(message: LeaseMessage): void {
  leaseChannel?.postMessage(message);
}

function publishDeleteIntent(assetIds: string[], fontIds: string[]): void {
  postLeaseMessage({ type: 'delete-intent', sessionId: leaseSessionId, assetIds, fontIds });
}

function publishDeleteComplete(assetIds: string[], fontIds: string[]): void {
  postLeaseMessage({ type: 'delete-complete', sessionId: leaseSessionId, assetIds, fontIds });
}

const audioStore: MediaLeaseStore = {
  counts: new Map(),
  deleting: new Set(),
  remoteLeases: new Map(),
  remoteDeleting: new Map(),
  deletionInProgress: (id) => new AssetDeletionInProgressError(id),
  deleteUnlocked: (id) => deleteAssetUnlocked(id),
  publishDeleteIntent: (ids) => publishDeleteIntent(ids, []),
  publishDeleteComplete: (ids) => publishDeleteComplete(ids, []),
};

const fontStore: MediaLeaseStore = {
  counts: new Map(),
  deleting: new Set(),
  remoteLeases: new Map(),
  remoteDeleting: new Map(),
  deletionInProgress: (id) => new FontDeletionInProgressError(id),
  deleteUnlocked: (id) => deleteFontUnlocked(id),
  publishDeleteIntent: (ids) => publishDeleteIntent([], ids),
  publishDeleteComplete: (ids) => publishDeleteComplete([], ids),
};

const stores: readonly MediaLeaseStore[] = [audioStore, fontStore];

function localLeaseIds(store: MediaLeaseStore): string[] {
  return [...store.counts.keys()].sort();
}

function publishLocalLeases(): void {
  postLeaseMessage({
    type: 'leases',
    sessionId: leaseSessionId,
    assetIds: localLeaseIds(audioStore),
    fontIds: localLeaseIds(fontStore),
  });
}

function refreshHeartbeat(): void {
  const hasLeases = stores.some((store) => store.counts.size > 0);
  if (hasLeases && !heartbeatTimer && leaseChannel) {
    heartbeatTimer = setInterval(publishLocalLeases, LEASE_HEARTBEAT_MS);
  } else if (!hasLeases && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function pruneExpiredRemoteLeases(now = Date.now()): void {
  for (const store of stores) {
    for (const [sessionId, snapshot] of store.remoteLeases) {
      if (snapshot.expiresAt <= now) store.remoteLeases.delete(sessionId);
    }
    for (const [id, expiresAt] of store.remoteDeleting) {
      if (expiresAt <= now) store.remoteDeleting.delete(id);
    }
  }
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
    for (const store of stores) store.remoteLeases.delete(message.sessionId);
    return;
  }
  if (
    message.type === 'delete-intent' &&
    isStringArray(message.assetIds) &&
    isStringArray(message.fontIds)
  ) {
    const expiresAt = Date.now() + REMOTE_LEASE_TTL_MS;
    for (const id of message.assetIds) audioStore.remoteDeleting.set(id, expiresAt);
    for (const id of message.fontIds) fontStore.remoteDeleting.set(id, expiresAt);
    // This is the delete-intent acknowledgement: send our current lease
    // snapshot before the peer's final in-lock recheck.
    publishLocalLeases();
    return;
  }
  if (
    message.type === 'delete-complete' &&
    isStringArray(message.assetIds) &&
    isStringArray(message.fontIds)
  ) {
    for (const id of message.assetIds) audioStore.remoteDeleting.delete(id);
    for (const id of message.fontIds) fontStore.remoteDeleting.delete(id);
    return;
  }
  if (message.type === 'leases' && isStringArray(message.assetIds)) {
    const expiresAt = Date.now() + REMOTE_LEASE_TTL_MS;
    audioStore.remoteLeases.set(message.sessionId, { ids: new Set(message.assetIds), expiresAt });
    // fontIds is optional for backward compatibility with older tabs.
    fontStore.remoteLeases.set(message.sessionId, {
      ids: new Set(isStringArray(message.fontIds) ? message.fontIds : []),
      expiresAt,
    });
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

/**
 * A second local owner may safely join an already-held lease while a peer has
 * announced delete intent: the original local lease was advertised before that
 * intent, so the remote collector's final recheck retains the id and rejecting
 * the handoff would create a protection gap.
 */
function assertAcquirable(store: MediaLeaseStore, id: string): void {
  if ((store.deleting.has(id) || store.remoteDeleting.has(id)) && !store.counts.has(id)) {
    throw store.deletionInProgress(id);
  }
}

function increment(store: MediaLeaseStore, id: string): void {
  pruneExpiredRemoteLeases();
  assertAcquirable(store, id);
  store.counts.set(id, (store.counts.get(id) ?? 0) + 1);
}

function decrement(store: MediaLeaseStore, id: string): void {
  const next = (store.counts.get(id) ?? 0) - 1;
  if (next > 0) store.counts.set(id, next);
  else store.counts.delete(id);
}

function acquireLease(store: MediaLeaseStore, ids: Iterable<string>): MediaLease {
  let held = new Set(ids);
  const acquired: string[] = [];
  try {
    for (const id of held) {
      increment(store, id);
      acquired.push(id);
    }
  } catch (error) {
    for (const id of acquired) decrement(store, id);
    throw error;
  }
  publishLocalLeases();
  refreshHeartbeat();
  let released = false;
  return {
    update(nextIds): void {
      if (released) return;
      const next = new Set(nextIds);
      const additions = [...next].filter((id) => !held.has(id));
      for (const id of additions) assertAcquirable(store, id);
      for (const id of additions) increment(store, id);
      for (const id of held) {
        if (!next.has(id)) decrement(store, id);
      }
      held = next;
      publishLocalLeases();
      refreshHeartbeat();
    },
    release(): void {
      if (released) return;
      released = true;
      for (const id of held) decrement(store, id);
      held.clear();
      publishLocalLeases();
      refreshHeartbeat();
    },
  };
}

function leasedIds(store: MediaLeaseStore): Set<string> {
  pruneExpiredRemoteLeases();
  return new Set([
    ...store.counts.keys(),
    ...[...store.remoteLeases.values()].flatMap((snapshot) => [...snapshot.ids]),
  ]);
}

function isLeased(store: MediaLeaseStore, id: string): boolean {
  pruneExpiredRemoteLeases();
  if (store.counts.has(id)) return true;
  for (const snapshot of store.remoteLeases.values()) {
    if (snapshot.ids.has(id)) return true;
  }
  return false;
}

/** Acquires a mutable lease over one or more audio asset ids. */
export function leaseAudioAssets(assetIds: Iterable<string>): AudioAssetLease {
  return acquireLease(audioStore, assetIds);
}

/** Acquires a mutable lease over one or more SoundFont ids. */
export function leaseFonts(fontIds: Iterable<string>): FontLease {
  return acquireLease(fontStore, fontIds);
}

/**
 * Reserves a group of media ids for one destructive operation. Callers must
 * synchronize leases after reserving and release the reservation when their
 * final reference checks and mutations finish.
 *
 * This is intentionally separate from the single-id guarded deletion helpers:
 * a collector can announce every candidate once, wait for peers once, then
 * perform many independent OPFS deletions without holding the mutation lock
 * through a grace period per file.
 */
export interface MediaDeletionReservation {
  audioAssetIds: ReadonlySet<string>;
  fontIds: ReadonlySet<string>;
  release(): void;
}

export function reserveMediaDeletion(
  audioAssetIds: Iterable<string>,
  fontIds: Iterable<string>,
): MediaDeletionReservation {
  const reservedAudioAssetIds = new Set(
    [...new Set(audioAssetIds)].filter((assetId) => !audioStore.deleting.has(assetId)),
  );
  const reservedFontIds = new Set(
    [...new Set(fontIds)].filter((fontId) => !fontStore.deleting.has(fontId)),
  );
  for (const assetId of reservedAudioAssetIds) audioStore.deleting.add(assetId);
  for (const fontId of reservedFontIds) fontStore.deleting.add(fontId);
  if (reservedAudioAssetIds.size > 0 || reservedFontIds.size > 0) {
    publishDeleteIntent([...reservedAudioAssetIds], [...reservedFontIds]);
  }

  let released = false;
  return {
    audioAssetIds: reservedAudioAssetIds,
    fontIds: reservedFontIds,
    release(): void {
      if (released) return;
      released = true;
      for (const assetId of reservedAudioAssetIds) audioStore.deleting.delete(assetId);
      for (const fontId of reservedFontIds) fontStore.deleting.delete(fontId);
      if (reservedAudioAssetIds.size > 0 || reservedFontIds.size > 0) {
        publishDeleteComplete([...reservedAudioAssetIds], [...reservedFontIds]);
      }
    },
  };
}

/** Snapshot of every asset id protected by at least one live lease. */
export function leasedAudioAssetIds(): Set<string> {
  return leasedIds(audioStore);
}

/** Snapshot of every SoundFont id protected by at least one live lease. */
export function leasedFontIds(): Set<string> {
  return leasedIds(fontStore);
}

export function isAudioAssetLeased(assetId: string): boolean {
  return isLeased(audioStore, assetId);
}

export function isFontLeased(fontId: string): boolean {
  return isLeased(fontStore, fontId);
}

/**
 * Requests a fresh lease snapshot from every live tab before destructive GC.
 * One `hello` refreshes both asset and font leases (they share a message).
 */
export async function synchronizeMediaLeases(): Promise<void> {
  if (!leaseChannel) return;
  pruneExpiredRemoteLeases();
  const hasKnownPeer = stores.some((store) => store.remoteLeases.size > 0);
  postLeaseMessage({ type: 'hello', sessionId: leaseSessionId });
  // Even without a previously observed peer, a tab may be suspended between
  // joining the channel and answering hello. Always reserve the full grace
  // period before destructive GC. Known peers retain a longer window because
  // a backgrounded tab may service a later request more slowly.
  await new Promise<void>((resolve) =>
    setTimeout(resolve, hasKnownPeer ? LEASE_SYNC_MS : INITIAL_LEASE_SYNC_MS),
  );
  pruneExpiredRemoteLeases();
}

/** Requests a fresh lease snapshot from every live tab before destructive GC. */
export async function synchronizeAudioAssetLeases(): Promise<Set<string>> {
  await synchronizeMediaLeases();
  return leasedAudioAssetIds();
}

/**
 * Deletes under an exclusive id guard, re-synchronizing cross-tab leases and
 * checking dynamic references immediately before the underlying OPFS mutation.
 * The delete intent is announced first: other tabs acknowledge with their
 * current lease set and reject any lease acquired after this point, closing
 * the recheck→unlink race.
 */
async function deleteGuarded(
  store: MediaLeaseStore,
  id: string,
  isReferenced: () => boolean | Promise<boolean>,
  alreadyLocked: boolean,
): Promise<boolean> {
  if (store.deleting.has(id)) return false;
  store.deleting.add(id);
  store.publishDeleteIntent([id]);
  const remove = async (): Promise<boolean> => {
    try {
      await synchronizeMediaLeases();
      if (isLeased(store, id) || (await isReferenced())) {
        return false;
      }
      await synchronizeMediaLeases();
      if (isLeased(store, id)) {
        return false;
      }
      await store.deleteUnlocked(id);
      return true;
    } finally {
      store.deleting.delete(id);
      store.publishDeleteComplete([id]);
    }
  };
  return alreadyLocked ? remove() : withPersistenceMutationLock(remove);
}

/**
 * Deletes an audio asset under an exclusive id guard, checking dynamic
 * references and leases immediately before the underlying OPFS mutation.
 */
export function deleteAudioAssetGuarded(
  assetId: string,
  isReferenced: () => boolean | Promise<boolean>,
  alreadyLocked = false,
): Promise<boolean> {
  return deleteGuarded(audioStore, assetId, isReferenced, alreadyLocked);
}

/**
 * Deletes a SoundFont under an exclusive id guard, so a font another tab's
 * live document still references is never removed.
 */
export function deleteFontGuarded(
  fontId: string,
  isReferenced: () => boolean | Promise<boolean>,
  alreadyLocked = false,
): Promise<boolean> {
  return deleteGuarded(fontStore, fontId, isReferenced, alreadyLocked);
}

/**
 * Deletes a group of audio assets under one reservation and one peer
 * synchronization. Reserving every id first means no peer can acquire any of
 * them once the synchronization window opens, so a single window covers the
 * batch. Ids already being deleted elsewhere are skipped.
 *
 * @returns The ids that were removed, in deletion order.
 */
export async function deleteAudioAssetsGuarded(
  assetIds: Iterable<string>,
  isReferenced: (assetId: string) => boolean | Promise<boolean>,
  alreadyLocked = false,
): Promise<string[]> {
  const reservation = reserveMediaDeletion(assetIds, []);
  const removed: string[] = [];
  const removeAll = async (): Promise<string[]> => {
    if (reservation.audioAssetIds.size === 0) return removed;
    await synchronizeMediaLeases();
    for (const assetId of reservation.audioAssetIds) {
      if (isAudioAssetLeased(assetId) || (await isReferenced(assetId))) continue;
      await deleteAssetUnlocked(assetId);
      removed.push(assetId);
    }
    return removed;
  };
  try {
    return await (alreadyLocked ? removeAll() : withPersistenceMutationLock(removeAll));
  } finally {
    reservation.release();
  }
}

/** Test-only reset for the process-global registry. */
export function clearAudioAssetLeases(): void {
  for (const store of stores) {
    store.counts.clear();
    store.deleting.clear();
    store.remoteLeases.clear();
    store.remoteDeleting.clear();
  }
  publishLocalLeases();
  refreshHeartbeat();
}
