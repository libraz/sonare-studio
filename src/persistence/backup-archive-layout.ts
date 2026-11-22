/**
 * Entry layout of the browser backup archive, shared by its writer and reader:
 * format identity, entry names, the inventory manifest and payload checksums.
 */

import { projectBytesRevision } from '@/persistence/opfs';
import { isRevisionSlot } from '@/persistence/revisions';

export const BACKUP_VERSION = 2;
export const BACKUP_APP_ID = 'sonare-studio';
export const BACKUP_KIND = 'browser-backup';
export const META_ENTRY = 'meta.json';
const PROJECTS_PREFIX = 'projects/';
const REVISIONS_PREFIX = 'revisions/';
export const REVISION_INDEX_ENTRY = `${REVISIONS_PREFIX}index.json`;
export const ASSETS_PREFIX = 'assets/';
export const FONTS_PREFIX = 'fonts/';

export interface BrowserBackupInventoryItem {
  id: string;
  bytes: number;
  checksum: string;
}

export interface BrowserBackupInventory {
  complete: boolean;
  totalBytes: number;
  projects: BrowserBackupInventoryItem[];
  assets: BrowserBackupInventoryItem[];
  fonts: BrowserBackupInventoryItem[];
  revisions: BrowserBackupInventoryItem[];
  revisionIndex?: BrowserBackupInventoryItem;
}

export interface BrowserBackupMeta {
  app: string;
  kind: string;
  version: number;
  savedAt: string;
  projects: number;
  assets: number;
  fonts: number;
  revisions: number;
  inventory?: BrowserBackupInventory;
}

export function projectEntryName(name: string): string {
  return `${PROJECTS_PREFIX}${encodeURIComponent(name)}.szd`;
}

export function revisionEntryName(slot: string): string {
  return `${REVISIONS_PREFIX}${encodeURIComponent(slot)}.szd`;
}

export function revisionSlotFromEntry(entryName: string): string | null {
  if (!entryName.startsWith(REVISIONS_PREFIX) || !entryName.endsWith('.szd')) return null;
  const encoded = entryName.slice(REVISIONS_PREFIX.length, -'.szd'.length);
  try {
    const slot = decodeURIComponent(encoded);
    return isRevisionSlot(slot) ? slot : null;
  } catch {
    return null;
  }
}

/** Accepts legacy archives that kept revision payloads under projects/. */
export function revisionSlotFromProjectEntry(entryName: string): string | null {
  const name = projectNameFromEntry(entryName);
  return name !== null && isRevisionSlot(name) ? name : null;
}

export function projectNameFromEntry(entryName: string): string | null {
  if (!entryName.startsWith(PROJECTS_PREFIX) || !entryName.endsWith('.szd')) return null;
  const encoded = entryName.slice(PROJECTS_PREFIX.length, -'.szd'.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function payloadChecksum(...parts: readonly Uint8Array[]): string {
  return parts.map((part) => projectBytesRevision(part)).join(':');
}

export function inventoryBytes(
  inventory: Omit<BrowserBackupInventory, 'complete' | 'totalBytes'>,
): number {
  return [
    ...inventory.projects,
    ...inventory.assets,
    ...inventory.fonts,
    ...inventory.revisions,
    ...(inventory.revisionIndex ? [inventory.revisionIndex] : []),
  ].reduce((total, item) => total + item.bytes, 0);
}
