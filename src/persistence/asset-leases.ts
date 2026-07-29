import { deleteFontUnlocked } from '@/project/fonts';
import { deleteAssetUnlocked } from './assets';
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

export interface AudioAssetLease {
  /** Replaces the protected id set without releasing the lease object. */
  update(assetIds: Iterable<string>): void;
  /** Releases every protected id. Idempotent. */
  release(): void;
}

const leaseCounts = new Map<string, number>();
const deletingIds = new Set<string>();
interface RemoteLeaseSnapshot {
  ids: Set<string>;
  expiresAt: number;
}

const remoteLeaseIds = new Map<string, RemoteLeaseSnapshot>();
const remoteDeletingAssetIds = new Map<string, number>();
// SoundFont leases mirror the audio-asset machinery so a tab's live fonts also
// survive another tab's media GC. Both kinds share one channel and message.
const fontLeaseCounts = new Map<string, number>();
const deletingFontIds = new Set<string>();
const remoteFontLeaseIds = new Map<string, RemoteLeaseSnapshot>();
const remoteDeletingFontIds = new Map<string, number>();
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
const leaseSessionId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

type LeaseMessage =
  | { type: 'hello'; sessionId: string }
  | { type: 'leases'; sessionId: string; assetIds: string[]; fontIds?: string[] }
  | { type: 'delete-intent'; sessionId: string; assetIds: string[]; fontIds: string[] }
  | { type: 'delete-complete'; sessionId: string; assetIds: string[]; fontIds: string[] }
  | { type: 'closed'; sessionId: string };

const leaseChannel =
  typeof BroadcastChannel === 'function' ? new BroadcastChannel(LEASE_CHANNEL_NAME) : null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function localLeaseIds(): string[] {
  return [...leaseCounts.keys()].sort();
}

function localFontLeaseIds(): string[] {
  return [...fontLeaseCounts.keys()].sort();
}

function postLeaseMessage(message: LeaseMessage): void {
  leaseChannel?.postMessage(message);
}

function publishLocalLeases(): void {
  postLeaseMessage({
    type: 'leases',
    sessionId: leaseSessionId,
    assetIds: localLeaseIds(),
    fontIds: localFontLeaseIds(),
  });
}

function publishDeleteIntent(assetIds: string[], fontIds: string[]): void {
  postLeaseMessage({ type: 'delete-intent', sessionId: leaseSessionId, assetIds, fontIds });
}

function publishDeleteComplete(assetIds: string[], fontIds: string[]): void {
  postLeaseMessage({ type: 'delete-complete', sessionId: leaseSessionId, assetIds, fontIds });
}

function refreshHeartbeat(): void {
  const hasLeases = leaseCounts.size > 0 || fontLeaseCounts.size > 0;
  if (hasLeases && !heartbeatTimer && leaseChannel) {
    heartbeatTimer = setInterval(publishLocalLeases, LEASE_HEARTBEAT_MS);
  } else if (!hasLeases && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function pruneExpiredRemoteLeases(now = Date.now()): void {
  for (const [sessionId, snapshot] of remoteLeaseIds) {
    if (snapshot.expiresAt <= now) remoteLeaseIds.delete(sessionId);
  }
  for (const [sessionId, snapshot] of remoteFontLeaseIds) {
    if (snapshot.expiresAt <= now) remoteFontLeaseIds.delete(sessionId);
  }
  for (const [id, expiresAt] of remoteDeletingAssetIds) {
    if (expiresAt <= now) remoteDeletingAssetIds.delete(id);
  }
  for (const [id, expiresAt] of remoteDeletingFontIds) {
    if (expiresAt <= now) remoteDeletingFontIds.delete(id);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
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
    remoteFontLeaseIds.delete(message.sessionId);
    return;
  }
  if (
    message.type === 'delete-intent' &&
    isStringArray(message.assetIds) &&
    isStringArray(message.fontIds)
  ) {
    const expiresAt = Date.now() + REMOTE_LEASE_TTL_MS;
    for (const id of message.assetIds) remoteDeletingAssetIds.set(id, expiresAt);
    for (const id of message.fontIds) remoteDeletingFontIds.set(id, expiresAt);
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
    for (const id of message.assetIds) remoteDeletingAssetIds.delete(id);
    for (const id of message.fontIds) remoteDeletingFontIds.delete(id);
    return;
  }
  if (message.type === 'leases' && isStringArray(message.assetIds)) {
    const expiresAt = Date.now() + REMOTE_LEASE_TTL_MS;
    remoteLeaseIds.set(message.sessionId, { ids: new Set(message.assetIds), expiresAt });
    // fontIds is optional for backward compatibility with older tabs.
    remoteFontLeaseIds.set(message.sessionId, {
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

function increment(assetId: string): void {
  pruneExpiredRemoteLeases();
  if (deletingIds.has(assetId) || remoteDeletingAssetIds.has(assetId))
    throw new AssetDeletionInProgressError(assetId);
  leaseCounts.set(assetId, (leaseCounts.get(assetId) ?? 0) + 1);
}

function decrement(assetId: string): void {
  const next = (leaseCounts.get(assetId) ?? 0) - 1;
  if (next > 0) leaseCounts.set(assetId, next);
  else leaseCounts.delete(assetId);
}

function incrementFont(fontId: string): void {
  pruneExpiredRemoteLeases();
  if (deletingFontIds.has(fontId) || remoteDeletingFontIds.has(fontId))
    throw new FontDeletionInProgressError(fontId);
  fontLeaseCounts.set(fontId, (fontLeaseCounts.get(fontId) ?? 0) + 1);
}

function decrementFont(fontId: string): void {
  const next = (fontLeaseCounts.get(fontId) ?? 0) - 1;
  if (next > 0) fontLeaseCounts.set(fontId, next);
  else fontLeaseCounts.delete(fontId);
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
  refreshHeartbeat();
  let released = false;
  return {
    update(nextIds): void {
      if (released) return;
      const next = new Set(nextIds);
      const additions = [...next].filter((assetId) => !held.has(assetId));
      for (const assetId of additions) {
        if (deletingIds.has(assetId) || remoteDeletingAssetIds.has(assetId))
          throw new AssetDeletionInProgressError(assetId);
      }
      for (const assetId of additions) increment(assetId);
      for (const assetId of held) {
        if (!next.has(assetId)) decrement(assetId);
      }
      held = next;
      publishLocalLeases();
      refreshHeartbeat();
    },
    release(): void {
      if (released) return;
      released = true;
      for (const assetId of held) decrement(assetId);
      held.clear();
      publishLocalLeases();
      refreshHeartbeat();
    },
  };
}

/** Interface for a mutable SoundFont lease (mirrors {@link AudioAssetLease}). */
export interface FontLease {
  update(fontIds: Iterable<string>): void;
  release(): void;
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
    [...new Set(audioAssetIds)].filter((assetId) => !deletingIds.has(assetId)),
  );
  const reservedFontIds = new Set(
    [...new Set(fontIds)].filter((fontId) => !deletingFontIds.has(fontId)),
  );
  for (const assetId of reservedAudioAssetIds) deletingIds.add(assetId);
  for (const fontId of reservedFontIds) deletingFontIds.add(fontId);
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
      for (const assetId of reservedAudioAssetIds) deletingIds.delete(assetId);
      for (const fontId of reservedFontIds) deletingFontIds.delete(fontId);
      if (reservedAudioAssetIds.size > 0 || reservedFontIds.size > 0) {
        publishDeleteComplete([...reservedAudioAssetIds], [...reservedFontIds]);
      }
    },
  };
}

/** Acquires a mutable lease over one or more SoundFont ids. */
export function leaseFonts(fontIds: Iterable<string>): FontLease {
  let held = new Set(fontIds);
  const acquired: string[] = [];
  try {
    for (const fontId of held) {
      incrementFont(fontId);
      acquired.push(fontId);
    }
  } catch (error) {
    for (const fontId of acquired) decrementFont(fontId);
    throw error;
  }
  publishLocalLeases();
  refreshHeartbeat();
  let released = false;
  return {
    update(nextIds): void {
      if (released) return;
      const next = new Set(nextIds);
      const additions = [...next].filter((fontId) => !held.has(fontId));
      for (const fontId of additions) {
        if (deletingFontIds.has(fontId) || remoteDeletingFontIds.has(fontId))
          throw new FontDeletionInProgressError(fontId);
      }
      for (const fontId of additions) incrementFont(fontId);
      for (const fontId of held) {
        if (!next.has(fontId)) decrementFont(fontId);
      }
      held = next;
      publishLocalLeases();
      refreshHeartbeat();
    },
    release(): void {
      if (released) return;
      released = true;
      for (const fontId of held) decrementFont(fontId);
      held.clear();
      publishLocalLeases();
      refreshHeartbeat();
    },
  };
}

/** Snapshot of every asset id protected by at least one live lease. */
export function leasedAudioAssetIds(): Set<string> {
  pruneExpiredRemoteLeases();
  return new Set([
    ...leaseCounts.keys(),
    ...[...remoteLeaseIds.values()].flatMap((snapshot) => [...snapshot.ids]),
  ]);
}

/** Snapshot of every SoundFont id protected by at least one live lease. */
export function leasedFontIds(): Set<string> {
  pruneExpiredRemoteLeases();
  return new Set([
    ...fontLeaseCounts.keys(),
    ...[...remoteFontLeaseIds.values()].flatMap((snapshot) => [...snapshot.ids]),
  ]);
}

export function isAudioAssetLeased(assetId: string): boolean {
  pruneExpiredRemoteLeases();
  if (leaseCounts.has(assetId)) return true;
  for (const snapshot of remoteLeaseIds.values()) {
    if (snapshot.ids.has(assetId)) return true;
  }
  return false;
}

export function isFontLeased(fontId: string): boolean {
  pruneExpiredRemoteLeases();
  if (fontLeaseCounts.has(fontId)) return true;
  for (const snapshot of remoteFontLeaseIds.values()) {
    if (snapshot.ids.has(fontId)) return true;
  }
  return false;
}

/**
 * Requests a fresh lease snapshot from every live tab before destructive GC.
 * One `hello` refreshes both asset and font leases (they share a message).
 */
export async function synchronizeMediaLeases(): Promise<void> {
  if (!leaseChannel) return;
  pruneExpiredRemoteLeases();
  const hasKnownPeer = remoteLeaseIds.size > 0 || remoteFontLeaseIds.size > 0;
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
  // Announce before the final synchronized recheck. Other tabs acknowledge
  // with their current lease set and reject any lease acquired after this
  // point, closing the recheck→unlink race.
  publishDeleteIntent([assetId], []);
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
      publishDeleteComplete([assetId], []);
    }
  };
  return alreadyLocked ? remove() : withPersistenceMutationLock(remove);
}

/**
 * Deletes a SoundFont under an exclusive id guard, re-synchronizing cross-tab
 * leases immediately before the OPFS mutation so a font another tab's live
 * document still references is never removed. Mirrors {@link deleteAudioAssetGuarded}.
 */
export async function deleteFontGuarded(
  fontId: string,
  isReferenced: () => boolean | Promise<boolean>,
  alreadyLocked = false,
): Promise<boolean> {
  if (deletingFontIds.has(fontId)) return false;
  deletingFontIds.add(fontId);
  publishDeleteIntent([], [fontId]);
  const remove = async (): Promise<boolean> => {
    try {
      await synchronizeMediaLeases();
      if (isFontLeased(fontId) || (await isReferenced())) {
        return false;
      }
      await synchronizeMediaLeases();
      if (isFontLeased(fontId)) {
        return false;
      }
      await deleteFontUnlocked(fontId);
      return true;
    } finally {
      deletingFontIds.delete(fontId);
      publishDeleteComplete([], [fontId]);
    }
  };
  return alreadyLocked ? remove() : withPersistenceMutationLock(remove);
}

/** Test-only reset for the process-global registry. */
export function clearAudioAssetLeases(): void {
  leaseCounts.clear();
  deletingIds.clear();
  remoteLeaseIds.clear();
  remoteDeletingAssetIds.clear();
  fontLeaseCounts.clear();
  deletingFontIds.clear();
  remoteFontLeaseIds.clear();
  remoteDeletingFontIds.clear();
  publishLocalLeases();
  refreshHeartbeat();
}
