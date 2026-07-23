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
const remoteLeaseIds = new Map<string, Set<string>>();
// SoundFont leases mirror the audio-asset machinery so a tab's live fonts also
// survive another tab's media GC. Both kinds share one channel and message.
const fontLeaseCounts = new Map<string, number>();
const deletingFontIds = new Set<string>();
const remoteFontLeaseIds = new Map<string, Set<string>>();
const LEASE_CHANNEL_NAME = 'sonare-studio:audio-asset-leases:v1';
// Give a backgrounded peer a realistic window to service the BroadcastChannel
// message. More importantly, its last advertised lease remains authoritative
// if it does not answer this particular sync request.
const LEASE_SYNC_MS = 1000;
const leaseSessionId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

type LeaseMessage =
  | { type: 'hello'; sessionId: string }
  | { type: 'leases'; sessionId: string; assetIds: string[]; fontIds?: string[] }
  | { type: 'closed'; sessionId: string };

const leaseChannel =
  typeof BroadcastChannel === 'function' ? new BroadcastChannel(LEASE_CHANNEL_NAME) : null;

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
  if (message.type === 'leases' && isStringArray(message.assetIds)) {
    remoteLeaseIds.set(message.sessionId, new Set(message.assetIds));
    // fontIds is optional for backward compatibility with older tabs.
    remoteFontLeaseIds.set(
      message.sessionId,
      new Set(isStringArray(message.fontIds) ? message.fontIds : []),
    );
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

function incrementFont(fontId: string): void {
  if (deletingFontIds.has(fontId)) throw new FontDeletionInProgressError(fontId);
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

/** Interface for a mutable SoundFont lease (mirrors {@link AudioAssetLease}). */
export interface FontLease {
  update(fontIds: Iterable<string>): void;
  release(): void;
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
  let released = false;
  return {
    update(nextIds): void {
      if (released) return;
      const next = new Set(nextIds);
      const additions = [...next].filter((fontId) => !held.has(fontId));
      for (const fontId of additions) {
        if (deletingFontIds.has(fontId)) throw new FontDeletionInProgressError(fontId);
      }
      for (const fontId of additions) incrementFont(fontId);
      for (const fontId of held) {
        if (!next.has(fontId)) decrementFont(fontId);
      }
      held = next;
      publishLocalLeases();
    },
    release(): void {
      if (released) return;
      released = true;
      for (const fontId of held) decrementFont(fontId);
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

/** Snapshot of every SoundFont id protected by at least one live lease. */
export function leasedFontIds(): Set<string> {
  return new Set([
    ...fontLeaseCounts.keys(),
    ...[...remoteFontLeaseIds.values()].flatMap((fontIds) => [...fontIds]),
  ]);
}

export function isAudioAssetLeased(assetId: string): boolean {
  if (leaseCounts.has(assetId)) return true;
  for (const assetIds of remoteLeaseIds.values()) {
    if (assetIds.has(assetId)) return true;
  }
  return false;
}

export function isFontLeased(fontId: string): boolean {
  if (fontLeaseCounts.has(fontId)) return true;
  for (const fontIds of remoteFontLeaseIds.values()) {
    if (fontIds.has(fontId)) return true;
  }
  return false;
}

/**
 * Requests a fresh lease snapshot from every live tab before destructive GC.
 * One `hello` refreshes both asset and font leases (they share a message).
 */
export async function synchronizeMediaLeases(): Promise<void> {
  if (!leaseChannel) return;
  postLeaseMessage({ type: 'hello', sessionId: leaseSessionId });
  // An unknown peer can answer this first hello, but local-only deletion
  // should not pay the full cross-tab timeout. One task turn admits immediate
  // BroadcastChannel replies; known peers retain the conservative 1s window.
  if (remoteLeaseIds.size === 0 && remoteFontLeaseIds.size === 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, LEASE_SYNC_MS));
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
    }
  };
  return alreadyLocked ? remove() : withPersistenceMutationLock(remove);
}

/** Test-only reset for the process-global registry. */
export function clearAudioAssetLeases(): void {
  leaseCounts.clear();
  deletingIds.clear();
  remoteLeaseIds.clear();
  fontLeaseCounts.clear();
  deletingFontIds.clear();
  remoteFontLeaseIds.clear();
  publishLocalLeases();
}
