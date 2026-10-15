/**
 * Whole-browser backup archive for OPFS-hosted sonare data.
 *
 * A .szd project export is intentionally project-scoped. This archive is the
 * broader safety net for browser-only storage: every saved project slot, every
 * shared audio asset and every SoundFont is packed into one zip so a user can
 * recover after clearing site data or moving to a new browser profile.
 */

import { strToU8 } from 'fflate';
import { createStreamingZipWriter } from '@/lib/streaming-zip';
import { preflightAndUnzipInWorker } from '@/persistence/archive-preflight';
import {
  deleteAssetUnlocked,
  listAssets,
  readAssetPcmBytes,
  saveAssetWithStatusUnlocked,
} from '@/persistence/assets';
import {
  prepareBrowserRestoreStage,
  reclaimOrphanedRestoreStages,
} from '@/persistence/backup-restore-journal';
import {
  audioFromPreparedAssetRestore,
  collectReferencedAssetIds,
  collectReferencedFontIds,
  type PreparedAssetRestore,
  type PreparedFontRestore,
  preflightAssetRestore,
  preflightFontRestore,
  prepareAssetRestore,
  prepareFontRestore,
} from '@/persistence/bundle';
import { bytesEqual, MEDIA_ID_PATTERN } from '@/persistence/fs-utils';
import { withPersistenceMutationLock } from '@/persistence/mutation-lock';
import {
  deleteProjectUnlocked,
  isReservedProjectName,
  listProjects,
  loadProject,
  ProjectNotFoundError,
  projectBytesRevision,
  sanitizeProjectName,
  saveProjectUnlocked,
} from '@/persistence/opfs';
import {
  MAX_BACKUP_ARCHIVE_COMPRESSED_BYTES,
  MAX_BACKUP_ARCHIVE_ENTRIES,
  MAX_BACKUP_ARCHIVE_ENTRY_BYTES,
  MAX_BACKUP_OUTER_EXPANDED_BYTES,
  MAX_BACKUP_TOTAL_EXPANDED_BYTES,
  MAX_PROJECT_ARCHIVE_ENTRY_BYTES,
} from '@/persistence/resource-limits';
import {
  isRevisionSlot,
  type ProjectRevision,
  type ProjectRevisionStoreSnapshot,
  readProjectRevisionStoreUnlocked,
  writeProjectRevisionIndexBytesUnlocked,
} from '@/persistence/revisions';
import { decodeSzdWithResourceReport } from '@/persistence/szd';
import {
  deleteFontUnlocked,
  listFonts,
  loadFont,
  saveFontWithStatusUnlocked,
} from '@/project/fonts';
import {
  createMediaCompletenessReport,
  type MediaCompletenessIssue,
  type MediaCompletenessReport,
  mediaFailureIssues,
} from '@/project/media-completeness';
import type { ProjectDocument } from '@/project/serialization';

export {
  reclaimOrphanedRestoreStages,
  reclaimOrphanedRestoreStagesAtStartup,
} from '@/persistence/backup-restore-journal';

const BACKUP_VERSION = 2;
const BACKUP_APP_ID = 'sonare-studio';
const BACKUP_KIND = 'browser-backup';
const META_ENTRY = 'meta.json';
const PROJECTS_PREFIX = 'projects/';
const REVISIONS_PREFIX = 'revisions/';
const REVISION_INDEX_ENTRY = `${REVISIONS_PREFIX}index.json`;
const ASSETS_PREFIX = 'assets/';
const FONTS_PREFIX = 'fonts/';

interface BrowserBackupInventoryItem {
  id: string;
  bytes: number;
  checksum: string;
}

interface BrowserBackupInventory {
  complete: boolean;
  totalBytes: number;
  projects: BrowserBackupInventoryItem[];
  assets: BrowserBackupInventoryItem[];
  fonts: BrowserBackupInventoryItem[];
  revisions: BrowserBackupInventoryItem[];
  revisionIndex?: BrowserBackupInventoryItem;
}

interface BrowserBackupMeta {
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

export interface BrowserBackupCreateResult {
  bytes: Uint8Array;
  completeness: MediaCompletenessReport;
}

export interface BrowserBackupExportLimits {
  maxCompressedBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxOuterExpandedBytes: number;
  maxTotalExpandedBytes: number;
}

const DEFAULT_EXPORT_LIMITS: BrowserBackupExportLimits = {
  maxCompressedBytes: MAX_BACKUP_ARCHIVE_COMPRESSED_BYTES,
  maxEntries: MAX_BACKUP_ARCHIVE_ENTRIES,
  maxEntryBytes: MAX_BACKUP_ARCHIVE_ENTRY_BYTES,
  maxOuterExpandedBytes: MAX_BACKUP_OUTER_EXPANDED_BYTES,
  maxTotalExpandedBytes: MAX_BACKUP_TOTAL_EXPANDED_BYTES,
};

export class BrowserBackupSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserBackupSizeError';
  }
}

export interface BrowserBackupRestoreResult {
  projects: number;
  assets: number;
  fonts: number;
  /** Valid media ids skipped because the backup omitted or corrupted their pair. */
  skippedAssetIds?: readonly string[];
  /** Valid SoundFont ids skipped because the backup omitted or corrupted their pair. */
  skippedFontIds?: readonly string[];
}

export class BrowserBackupRecoveryError extends Error {
  constructor(
    readonly restoreError: unknown,
    readonly rollbackFailures: readonly unknown[],
  ) {
    const reason = restoreError instanceof Error ? restoreError.message : String(restoreError);
    super(
      `Browser backup restore failed (${reason}); ${rollbackFailures.length} rollback operation(s) also failed`,
      { cause: restoreError },
    );
    this.name = 'BrowserBackupRecoveryError';
  }
}

/** Durable publish boundaries exposed only to the backup-restore fault tests. */
export type BrowserBackupRestoreFaultPoint =
  | 'asset-intent'
  | 'asset-published'
  | 'font-intent'
  | 'font-published'
  | 'project-intent'
  | 'project-published'
  | 'revision-index-intent'
  | 'revision-index-published'
  | 'finalized';

type BrowserBackupRestoreFaultInjector = (
  point: BrowserBackupRestoreFaultPoint,
) => boolean | Promise<boolean>;

let restoreFaultInjector: BrowserBackupRestoreFaultInjector | null = null;

class SimulatedBrowserBackupCrash extends Error {
  constructor(readonly point: BrowserBackupRestoreFaultPoint) {
    super(`Simulated browser backup restore crash after ${point}`);
    this.name = 'SimulatedBrowserBackupCrash';
  }
}

/**
 * Installs a test-only crash hook immediately after a durable live-namespace
 * write. Production code never sets this hook; it lets the persistence spec
 * model a tab/process death without running the normal in-process rollback.
 */
export function setBrowserBackupRestoreFaultInjectorForTests(
  injector: BrowserBackupRestoreFaultInjector | null,
): void {
  restoreFaultInjector = injector;
}

async function injectRestoreCrash(point: BrowserBackupRestoreFaultPoint): Promise<void> {
  if (await restoreFaultInjector?.(point)) throw new SimulatedBrowserBackupCrash(point);
}

function projectEntryName(name: string): string {
  return `${PROJECTS_PREFIX}${encodeURIComponent(name)}.szd`;
}

function revisionEntryName(slot: string): string {
  return `${REVISIONS_PREFIX}${encodeURIComponent(slot)}.szd`;
}

function revisionSlotFromEntry(entryName: string): string | null {
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
function revisionSlotFromProjectEntry(entryName: string): string | null {
  const name = projectNameFromEntry(entryName);
  return name !== null && isRevisionSlot(name) ? name : null;
}

function projectNameFromEntry(entryName: string): string | null {
  if (!entryName.startsWith(PROJECTS_PREFIX) || !entryName.endsWith('.szd')) return null;
  const encoded = entryName.slice(PROJECTS_PREFIX.length, -'.szd'.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function parseJson<T>(bytes: Uint8Array): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

function payloadChecksum(...parts: readonly Uint8Array[]): string {
  return parts.map((part) => projectBytesRevision(part)).join(':');
}

function inventoryBytes(
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

function createBackupZipWriter(
  savedAt: string,
  signal?: AbortSignal,
  limits: BrowserBackupExportLimits = DEFAULT_EXPORT_LIMITS,
): {
  add(name: string, bytes: Uint8Array): Promise<void>;
  abort(): void;
  close(): Promise<Uint8Array>;
  stats(): { entries: number; uncompressedBytes: number };
} {
  const writer = createStreamingZipWriter({
    mtime: savedAt,
    signal,
    maxEntries: limits.maxEntries,
    maxEntryBytes: limits.maxEntryBytes,
    maxUncompressedBytes: limits.maxOuterExpandedBytes,
    maxCompressedBytes: limits.maxCompressedBytes,
    createLimitError: (message) => new BrowserBackupSizeError(message),
  });
  return {
    abort(): void {
      writer.abort();
    },
    add(name, bytes): Promise<void> {
      return writer.add(name, bytes);
    },
    async close(): Promise<Uint8Array> {
      return writer.close();
    },
    stats(): { entries: number; uncompressedBytes: number } {
      return writer.stats();
    },
  };
}

function assertNestedBackupBudget(
  outer: { entries: number; uncompressedBytes: number },
  nested: { entries: number; uncompressedBytes: number },
  limits: BrowserBackupExportLimits,
): void {
  if (outer.entries + nested.entries > limits.maxEntries) {
    throw new BrowserBackupSizeError(
      'Browser backup nested project entry count exceeds its restore limit',
    );
  }
  if (outer.uncompressedBytes + nested.uncompressedBytes > limits.maxTotalExpandedBytes) {
    throw new BrowserBackupSizeError(
      'Browser backup nested project expansion exceeds its restore limit',
    );
  }
}

function addProjectMediaIssues(
  issues: MediaCompletenessIssue[],
  documents: readonly ProjectDocument[],
  kind: 'audio-asset' | 'soundfont',
  successfulIds: ReadonlySet<string>,
  listedFailures: ReadonlyMap<string, unknown>,
): void {
  const referencedIds = new Set<string>();
  for (const doc of documents) {
    const ids =
      kind === 'audio-asset' ? collectReferencedAssetIds(doc) : collectReferencedFontIds(doc);
    for (const id of ids) {
      referencedIds.add(id);
      if (successfulIds.has(id)) continue;
      issues.push(
        ...mediaFailureIssues(
          doc,
          kind,
          id,
          listedFailures.has(id) ? 'unreadable' : 'missing',
          listedFailures.get(id),
        ),
      );
    }
  }
  for (const [id, error] of listedFailures) {
    if (referencedIds.has(id)) continue;
    issues.push({
      kind,
      mediaId: id,
      role: 'library',
      reason: 'unreadable',
      ...(error instanceof Error && error.message ? { message: error.message } : {}),
    });
  }
}

/**
 * Creates one zip containing all saved projects plus shared OPFS media stores.
 */
async function createBrowserBackupLocked(
  savedAt = new Date().toISOString(),
  signal?: AbortSignal,
  limits: BrowserBackupExportLimits = DEFAULT_EXPORT_LIMITS,
): Promise<BrowserBackupCreateResult> {
  const zip = createBackupZipWriter(savedAt, signal, limits);
  const build = async (): Promise<BrowserBackupCreateResult> => {
    const inventory = { projects: [], assets: [], fonts: [], revisions: [] } as Omit<
      BrowserBackupInventory,
      'complete' | 'totalBytes'
    >;
    const documents: ProjectDocument[] = [];
    const nested = { entries: 0, uncompressedBytes: 0 };
    const unreadableIssues: MediaCompletenessIssue[] = [];
    // An undecodable stored payload is still carried verbatim; its media references are unknown, so it is reported.
    const readDocument = (slot: string, bytes: Uint8Array): void => {
      try {
        const decoded = decodeSzdWithResourceReport(bytes, {});
        documents.push(decoded.document);
        nested.entries += decoded.report.entries;
        nested.uncompressedBytes += decoded.report.uncompressedBytes;
      } catch (error) {
        if (error instanceof BrowserBackupSizeError) throw error;
        unreadableIssues.push({
          kind: 'stored-project',
          mediaId: slot,
          role: 'library',
          reason: 'unreadable',
          projectName: slot,
          ...(error instanceof Error && error.message ? { message: error.message } : {}),
        });
      }
    };

    for (const project of await listProjects()) {
      if (isReservedProjectName(project.name)) continue;
      signal?.throwIfAborted();
      const bytes = await loadProject(project.name);
      readDocument(project.name, bytes);
      const payloadBytes = bytes.byteLength;
      const checksum = payloadChecksum(bytes);
      await zip.add(projectEntryName(project.name), bytes);
      assertNestedBackupBudget(zip.stats(), nested, limits);
      inventory.projects.push({
        id: project.name,
        bytes: payloadBytes,
        checksum,
      });
    }

    const revisionStore = await readProjectRevisionStoreUnlocked();
    // Older revision indexes did not persist `size`.  When their payload is
    // still present, publish the measured size into the portable index so the
    // archive remains internally consistent with the payload it carries.
    // Stale entries without a payload deliberately retain their legacy value:
    // a backup may represent historical metadata whose slot was already
    // pruned before export.
    const revisionIndex = strToU8(
      JSON.stringify(
        revisionStore.index.map((entry) => {
          const bytes = revisionStore.slots.get(entry.slot);
          return bytes === undefined ? entry : { ...entry, size: bytes.byteLength };
        }),
      ),
    );
    await zip.add(REVISION_INDEX_ENTRY, revisionIndex);
    inventory.revisionIndex = {
      id: 'index',
      bytes: revisionIndex.byteLength,
      checksum: payloadChecksum(revisionIndex),
    };
    for (const [slot, bytes] of revisionStore.slots) {
      signal?.throwIfAborted();
      readDocument(slot, bytes);
      const payloadBytes = bytes.byteLength;
      await zip.add(revisionEntryName(slot), bytes);
      assertNestedBackupBudget(zip.stats(), nested, limits);
      inventory.revisions.push({
        id: slot,
        bytes: payloadBytes,
        checksum: payloadChecksum(bytes),
      });
    }

    const successfulAssets = new Set<string>();
    const assetFailures = new Map<string, unknown>();
    for (const asset of await listAssets()) {
      try {
        // Backups own these bytes only for the duration of the zip stream. Do
        // not populate the playback LRU while walking the whole asset library.
        const loaded = await readAssetPcmBytes(asset.id);
        signal?.throwIfAborted();
        const meta = strToU8(JSON.stringify(loaded.meta));
        const pcm = loaded.pcm;
        const payloadBytes = meta.byteLength + pcm.byteLength;
        const checksum = payloadChecksum(meta, pcm);
        await zip.add(`${ASSETS_PREFIX}${asset.id}.json`, meta);
        await zip.add(`${ASSETS_PREFIX}${asset.id}.pcm`, pcm);
        assertNestedBackupBudget(zip.stats(), nested, limits);
        successfulAssets.add(asset.id);
        inventory.assets.push({
          id: asset.id,
          bytes: payloadBytes,
          checksum,
        });
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        if (error instanceof BrowserBackupSizeError) throw error;
        assetFailures.set(asset.id, error);
      }
    }

    const successfulFonts = new Set<string>();
    const fontFailures = new Map<string, unknown>();
    for (const font of await listFonts()) {
      try {
        const meta = strToU8(JSON.stringify(font));
        // Backups own these bytes only for the duration of the zip stream.
        // Do not populate the playback LRU while walking an entire library.
        const sf2 = await loadFont(font.id, { cache: false });
        signal?.throwIfAborted();
        const payloadBytes = meta.byteLength + sf2.byteLength;
        const checksum = payloadChecksum(meta, sf2);
        await zip.add(`${FONTS_PREFIX}${font.id}.json`, meta);
        await zip.add(`${FONTS_PREFIX}${font.id}.sf2`, sf2);
        assertNestedBackupBudget(zip.stats(), nested, limits);
        successfulFonts.add(font.id);
        inventory.fonts.push({
          id: font.id,
          bytes: payloadBytes,
          checksum,
        });
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        if (error instanceof BrowserBackupSizeError) throw error;
        fontFailures.set(font.id, error);
      }
    }

    const issues: MediaCompletenessIssue[] = [...unreadableIssues];
    addProjectMediaIssues(issues, documents, 'audio-asset', successfulAssets, assetFailures);
    addProjectMediaIssues(issues, documents, 'soundfont', successfulFonts, fontFailures);
    const completeness = createMediaCompletenessReport(issues);

    const meta: BrowserBackupMeta = {
      app: BACKUP_APP_ID,
      kind: BACKUP_KIND,
      version: BACKUP_VERSION,
      savedAt,
      projects: inventory.projects.length,
      assets: inventory.assets.length,
      fonts: inventory.fonts.length,
      revisions: inventory.revisions.length,
      inventory: {
        complete: completeness.complete,
        totalBytes: inventoryBytes(inventory),
        ...inventory,
      },
    };
    await zip.add(META_ENTRY, strToU8(JSON.stringify(meta)));
    assertNestedBackupBudget(zip.stats(), nested, limits);
    return { bytes: await zip.close(), completeness };
  };
  try {
    return await build();
  } catch (error) {
    zip.abort();
    throw error;
  }
}

export function createBrowserBackupWithReport(
  savedAt = new Date().toISOString(),
  signal?: AbortSignal,
  limits: BrowserBackupExportLimits = DEFAULT_EXPORT_LIMITS,
): Promise<BrowserBackupCreateResult> {
  return withPersistenceMutationLock(() => createBrowserBackupLocked(savedAt, signal, limits), {
    signal,
  });
}

export function createBrowserBackup(
  savedAt = new Date().toISOString(),
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return createBrowserBackupWithReport(savedAt, signal).then((result) => result.bytes);
}

function invalidBackup(): never {
  throw new Error('Invalid sonare browser backup.');
}

function validatedInventoryItems(value: unknown): BrowserBackupInventoryItem[] {
  if (!Array.isArray(value)) invalidBackup();
  const ids = new Set<string>();
  return value.map((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as BrowserBackupInventoryItem).id !== 'string' ||
      (item as BrowserBackupInventoryItem).id.length === 0 ||
      !Number.isSafeInteger((item as BrowserBackupInventoryItem).bytes) ||
      (item as BrowserBackupInventoryItem).bytes < 0 ||
      typeof (item as BrowserBackupInventoryItem).checksum !== 'string'
    ) {
      invalidBackup();
    }
    const parsed = item as BrowserBackupInventoryItem;
    if (ids.has(parsed.id)) invalidBackup();
    ids.add(parsed.id);
    return parsed;
  });
}

function assertInventoryCategory(
  expected: readonly BrowserBackupInventoryItem[],
  actual: readonly BrowserBackupInventoryItem[],
): void {
  if (expected.length !== actual.length) invalidBackup();
  const byId = new Map(actual.map((item) => [item.id, item]));
  for (const item of expected) {
    const found = byId.get(item.id);
    if (!found || found.bytes !== item.bytes || found.checksum !== item.checksum) invalidBackup();
  }
}

function validateBrowserBackupInventory(
  entries: Readonly<Record<string, Uint8Array>>,
  meta: Partial<BrowserBackupMeta>,
): void {
  const raw = meta.inventory as Partial<BrowserBackupInventory> | undefined;
  if (
    !raw ||
    typeof raw.complete !== 'boolean' ||
    !Number.isSafeInteger(raw.totalBytes) ||
    (raw.totalBytes as number) < 0
  ) {
    invalidBackup();
  }
  const expected = {
    projects: validatedInventoryItems(raw.projects),
    assets: validatedInventoryItems(raw.assets),
    fonts: validatedInventoryItems(raw.fonts),
    // v2 backups created before revision-history support have no revision
    // inventory. Treat that absence as an empty category for compatibility.
    revisions: raw.revisions === undefined ? [] : validatedInventoryItems(raw.revisions),
    revisionIndex:
      raw.revisionIndex === undefined ? [] : validatedInventoryItems([raw.revisionIndex]),
  };
  if (
    meta.projects !== expected.projects.length ||
    meta.assets !== expected.assets.length ||
    meta.fonts !== expected.fonts.length ||
    (meta.revisions !== undefined && meta.revisions !== expected.revisions.length)
  ) {
    invalidBackup();
  }

  const knownEntries = new Set([META_ENTRY]);
  const actual = { projects: [], assets: [], fonts: [], revisions: [] } as Omit<
    BrowserBackupInventory,
    'complete' | 'totalBytes'
  >;
  for (const [entryName, data] of Object.entries(entries)) {
    if (entryName === REVISION_INDEX_ENTRY) {
      knownEntries.add(entryName);
      actual.revisionIndex = {
        id: 'index',
        bytes: data.byteLength,
        checksum: payloadChecksum(data),
      };
      continue;
    }
    const revisionSlot =
      revisionSlotFromEntry(entryName) ?? revisionSlotFromProjectEntry(entryName);
    if (revisionSlot !== null) {
      knownEntries.add(entryName);
      actual.revisions.push({
        id: revisionSlot,
        bytes: data.byteLength,
        checksum: payloadChecksum(data),
      });
      continue;
    }
    const projectName = projectNameFromEntry(entryName);
    if (projectName !== null) {
      knownEntries.add(entryName);
      actual.projects.push({
        id: projectName,
        bytes: data.byteLength,
        checksum: payloadChecksum(data),
      });
      continue;
    }
    if (entryName.startsWith(ASSETS_PREFIX) && entryName.endsWith('.pcm')) {
      const id = entryName.slice(ASSETS_PREFIX.length, -'.pcm'.length);
      const metaName = `${ASSETS_PREFIX}${id}.json`;
      const metaBytes = entries[metaName];
      if (!MEDIA_ID_PATTERN.test(id) || !metaBytes) invalidBackup();
      knownEntries.add(entryName);
      knownEntries.add(metaName);
      actual.assets.push({
        id,
        bytes: metaBytes.byteLength + data.byteLength,
        checksum: payloadChecksum(metaBytes, data),
      });
      continue;
    }
    if (entryName.startsWith(FONTS_PREFIX) && entryName.endsWith('.sf2')) {
      const id = entryName.slice(FONTS_PREFIX.length, -'.sf2'.length);
      const metaName = `${FONTS_PREFIX}${id}.json`;
      const metaBytes = entries[metaName];
      if (!MEDIA_ID_PATTERN.test(id) || !metaBytes) invalidBackup();
      knownEntries.add(entryName);
      knownEntries.add(metaName);
      actual.fonts.push({
        id,
        bytes: metaBytes.byteLength + data.byteLength,
        checksum: payloadChecksum(metaBytes, data),
      });
    }
  }
  if (Object.keys(entries).some((name) => !knownEntries.has(name))) invalidBackup();
  assertInventoryCategory(expected.projects, actual.projects);
  assertInventoryCategory(expected.assets, actual.assets);
  assertInventoryCategory(expected.fonts, actual.fonts);
  assertInventoryCategory(expected.revisions, actual.revisions);
  assertInventoryCategory(
    expected.revisionIndex,
    actual.revisionIndex ? [actual.revisionIndex] : [],
  );
  if (raw.totalBytes !== inventoryBytes(actual)) invalidBackup();
}

function parseRevisionIndex(bytes: Uint8Array): ProjectRevision[] {
  const raw = parseJson<unknown>(bytes);
  if (!Array.isArray(raw)) invalidBackup();
  const slots = new Set<string>();
  const entries: ProjectRevision[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== 'object' || candidate === null) invalidBackup();
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.slot !== 'string' ||
      !isRevisionSlot(record.slot) ||
      slots.has(record.slot) ||
      typeof record.projectName !== 'string' ||
      typeof record.label !== 'string' ||
      typeof record.savedAt !== 'number' ||
      !Number.isFinite(record.savedAt) ||
      (record.size !== undefined &&
        (!Number.isSafeInteger(record.size) || (record.size as number) < 0))
    ) {
      invalidBackup();
    }
    try {
      sanitizeProjectName(record.projectName);
    } catch {
      invalidBackup();
    }
    slots.add(record.slot);
    entries.push({
      slot: record.slot,
      projectName: record.projectName,
      label: record.label,
      savedAt: record.savedAt,
      size: typeof record.size === 'number' ? record.size : 0,
    });
  }
  return entries;
}

function sameProjectRevision(left: ProjectRevision, right: ProjectRevision): boolean {
  return (
    left.slot === right.slot &&
    left.projectName === right.projectName &&
    left.label === right.label &&
    left.savedAt === right.savedAt &&
    left.size === right.size
  );
}

function revisionSlotConflict(slot: string): never {
  throw new Error(`Browser backup revision slot conflicts with existing data: "${slot}"`);
}

/**
 * Plans an additive revision restore before anything is published. Revision
 * slots have global names, so a matching name is safe only when its bytes and
 * metadata are identical; otherwise replacing it would silently corrupt a
 * different local project's history. The merged index retains all local
 * records and adds archive records that do not already exist.
 */
function planRevisionRestore(
  archiveIndex: readonly ProjectRevision[] | undefined,
  archiveSlots: readonly { name: string; bytes: Uint8Array }[],
  existing: ProjectRevisionStoreSnapshot,
): {
  mergedIndex: ProjectRevision[] | undefined;
  slotsToPublish: Array<{ name: string; bytes: Uint8Array }>;
} {
  const archiveBytesBySlot = new Map(archiveSlots.map((slot) => [slot.name, slot.bytes]));
  for (const [slot, bytes] of archiveBytesBySlot) {
    const current = existing.slots.get(slot);
    if (current !== undefined && !bytesEqual(current, bytes)) revisionSlotConflict(slot);
  }

  const slotsToPublish = archiveSlots.filter((slot) => !existing.slots.has(slot.name));
  if (archiveIndex === undefined) {
    return { mergedIndex: undefined, slotsToPublish };
  }

  const existingBySlot = new Map<string, ProjectRevision>();
  for (const entry of existing.index) {
    const previous = existingBySlot.get(entry.slot);
    if (previous !== undefined && !sameProjectRevision(previous, entry)) {
      revisionSlotConflict(entry.slot);
    }
    existingBySlot.set(entry.slot, entry);
  }

  const mergedIndex = [...existing.index];
  for (const entry of archiveIndex) {
    const incomingBytes = archiveBytesBySlot.get(entry.slot);
    if (incomingBytes !== undefined && entry.size !== incomingBytes.byteLength) invalidBackup();
    const existingEntry = existingBySlot.get(entry.slot);
    if (existingEntry !== undefined) {
      if (!sameProjectRevision(existingEntry, entry)) revisionSlotConflict(entry.slot);
      continue;
    }
    // A stale archive index is valid, but it must not claim an unrelated
    // local payload when the archive provides no bytes to prove identity.
    if (incomingBytes === undefined && existing.slots.has(entry.slot)) {
      revisionSlotConflict(entry.slot);
    }
    existingBySlot.set(entry.slot, entry);
    mergedIndex.push(entry);
  }
  return { mergedIndex, slotsToPublish };
}

/** Restores a browser backup as one preflighted, rollback-capable transaction. */
async function restoreBrowserBackupUnlocked(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<BrowserBackupRestoreResult> {
  // Reclaim any staging namespace a previously crashed restore left behind
  // before this run stages its own, so orphans cannot accumulate unbounded.
  await reclaimOrphanedRestoreStages();
  const outerArchive = await preflightAndUnzipInWorker(
    bytes,
    {
      maxCompressedBytes: MAX_BACKUP_ARCHIVE_COMPRESSED_BYTES,
      maxEntries: MAX_BACKUP_ARCHIVE_ENTRIES,
      maxEntryBytes: MAX_BACKUP_ARCHIVE_ENTRY_BYTES,
      maxUncompressedBytes: MAX_BACKUP_OUTER_EXPANDED_BYTES,
    },
    signal,
  );
  const entries = outerArchive.entries;
  let remainingExpandedBytes =
    MAX_BACKUP_TOTAL_EXPANDED_BYTES - outerArchive.report.uncompressedBytes;
  let remainingEntries = MAX_BACKUP_ARCHIVE_ENTRIES - outerArchive.report.entries;
  const meta = entries[META_ENTRY]
    ? parseJson<Partial<BrowserBackupMeta>>(entries[META_ENTRY])
    : null;
  if (
    meta?.app !== BACKUP_APP_ID ||
    meta.kind !== BACKUP_KIND ||
    (meta.version !== 1 && meta.version !== BACKUP_VERSION)
  ) {
    throw new Error('Invalid sonare browser backup.');
  }
  if (meta.version === BACKUP_VERSION) validateBrowserBackupInventory(entries, meta);

  const projects: Array<{ name: string; bytes: Uint8Array }> = [];
  const projectNames = new Set<string>();
  for (const [entryName, data] of Object.entries(entries)) {
    signal?.throwIfAborted();
    const archiveName = projectNameFromEntry(entryName);
    if (!archiveName) continue;
    const name = sanitizeProjectName(archiveName);
    // Autosave/session recovery belongs to the current browser session and is
    // deliberately never replaced by a portable browser-backup import.
    if (isReservedProjectName(name)) continue;
    if (projectNames.has(name)) {
      throw new Error(`Browser backup contains colliding project name: "${name}"`);
    }
    projectNames.add(name);
    if (remainingExpandedBytes <= 0 || remainingEntries <= 0) {
      throw new Error('Browser backup nested project expansion exceeds the cumulative budget');
    }
    const decoded = decodeSzdWithResourceReport(data, {
      maxEntries: remainingEntries,
      maxEntryBytes: Math.min(MAX_PROJECT_ARCHIVE_ENTRY_BYTES, remainingExpandedBytes),
      maxUncompressedBytes: remainingExpandedBytes,
    });
    remainingExpandedBytes -= decoded.report.uncompressedBytes;
    remainingEntries -= decoded.report.entries;
    projects.push({ name, bytes: data });
  }

  const revisionIndexBytes = entries[REVISION_INDEX_ENTRY];
  const archiveRevisionIndex = revisionIndexBytes
    ? parseRevisionIndex(revisionIndexBytes)
    : undefined;
  const revisionSlots: Array<{ name: string; bytes: Uint8Array }> = [];
  const revisionSlotNames = new Set<string>();
  for (const [entryName, data] of Object.entries(entries)) {
    signal?.throwIfAborted();
    const slot = revisionSlotFromEntry(entryName) ?? revisionSlotFromProjectEntry(entryName);
    if (slot === null) continue;
    if (revisionSlotNames.has(slot)) invalidBackup();
    if (remainingExpandedBytes <= 0 || remainingEntries <= 0) {
      throw new Error('Browser backup nested revision expansion exceeds the cumulative budget');
    }
    const decoded = decodeSzdWithResourceReport(data, {
      maxEntries: remainingEntries,
      maxEntryBytes: Math.min(MAX_PROJECT_ARCHIVE_ENTRY_BYTES, remainingExpandedBytes),
      maxUncompressedBytes: remainingExpandedBytes,
    });
    remainingExpandedBytes -= decoded.report.uncompressedBytes;
    remainingEntries -= decoded.report.entries;
    revisionSlotNames.add(slot);
    revisionSlots.push({ name: slot, bytes: data });
  }

  const mediaIds = (prefix: string, payloadExtension: string): string[] =>
    [
      ...new Set(
        Object.keys(entries).flatMap((entryName) => {
          if (!entryName.startsWith(prefix)) return [];
          const basename = entryName.slice(prefix.length);
          const id = basename.endsWith(payloadExtension)
            ? basename.slice(0, -payloadExtension.length)
            : basename.endsWith('.json')
              ? basename.slice(0, -'.json'.length)
              : null;
          return id !== null && MEDIA_ID_PATTERN.test(id) ? [id] : [];
        }),
      ),
    ].sort();
  const skippedAssetIds: string[] = [];
  const assets: PreparedAssetRestore[] = [];
  for (const id of mediaIds(ASSETS_PREFIX, '.pcm')) {
    const pcm = entries[`${ASSETS_PREFIX}${id}.pcm`];
    const assetMeta = entries[`${ASSETS_PREFIX}${id}.json`];
    if (!pcm || !assetMeta) {
      skippedAssetIds.push(id);
      continue;
    }
    try {
      assets.push(prepareAssetRestore({ id, meta: assetMeta, pcm }));
    } catch {
      skippedAssetIds.push(id);
    }
  }
  const skippedFontIds: string[] = [];
  const fonts: PreparedFontRestore[] = [];
  for (const id of mediaIds(FONTS_PREFIX, '.sf2')) {
    const sf2 = entries[`${FONTS_PREFIX}${id}.sf2`];
    const fontMeta = entries[`${FONTS_PREFIX}${id}.json`];
    if (!sf2 || !fontMeta) {
      skippedFontIds.push(id);
      continue;
    }
    try {
      fonts.push(prepareFontRestore({ id, meta: fontMeta, sf2 }));
    } catch {
      skippedFontIds.push(id);
    }
  }

  const existingAssets = new Set<string>();
  const existingFonts = new Set<string>();
  for (const entry of assets) {
    if (await preflightAssetRestore(entry)) existingAssets.add(entry.id);
    signal?.throwIfAborted();
  }
  for (const entry of fonts) {
    if (await preflightFontRestore(entry)) existingFonts.add(entry.id);
    signal?.throwIfAborted();
  }
  const existingRevisionStore = await readProjectRevisionStoreUnlocked();
  const revisionPlan = planRevisionRestore(
    archiveRevisionIndex,
    revisionSlots,
    existingRevisionStore,
  );
  const stageProjects = [...projects, ...revisionPlan.slotsToPublish];
  const previousProjects = new Map<string, Uint8Array | null>();
  for (const project of stageProjects) {
    try {
      previousProjects.set(project.name, await loadProject(project.name));
      signal?.throwIfAborted();
    } catch (error) {
      if (error instanceof ProjectNotFoundError) previousProjects.set(project.name, null);
      else throw error;
    }
  }

  const revisionRestore =
    revisionPlan.mergedIndex !== undefined
      ? {
          bytes: strToU8(JSON.stringify(revisionPlan.mergedIndex)),
          previousBytes: existingRevisionStore.indexBytes,
        }
      : undefined;

  const stage = await prepareBrowserRestoreStage(
    stageProjects,
    previousProjects,
    assets.map((entry) => entry.id),
    fonts.map((entry) => entry.id),
    revisionRestore,
    signal,
  );

  const createdAssets: string[] = [];
  const createdFonts: string[] = [];
  let revisionIndexIntentStarted = false;
  try {
    for (const entry of assets) {
      if (existingAssets.has(entry.id)) continue;
      await stage.beginAssetPublish(entry.id);
      await injectRestoreCrash('asset-intent');
      createdAssets.push(entry.id);
      await saveAssetWithStatusUnlocked(
        {
          id: entry.id,
          name: entry.meta.name,
          sampleRate: entry.meta.sampleRate,
          numChannels: entry.meta.numChannels,
          ...(entry.meta.tags ? { tags: entry.meta.tags } : {}),
        },
        audioFromPreparedAssetRestore(entry),
      );
      await injectRestoreCrash('asset-published');
      signal?.throwIfAborted();
    }
    for (const entry of fonts) {
      if (existingFonts.has(entry.id)) continue;
      await stage.beginFontPublish(entry.id);
      await injectRestoreCrash('font-intent');
      createdFonts.push(entry.id);
      await saveFontWithStatusUnlocked({ id: entry.id, name: entry.meta.name }, entry.data);
      await injectRestoreCrash('font-published');
      signal?.throwIfAborted();
    }
    for (const project of stageProjects) {
      await stage.beginProjectPublish(project.name);
      await injectRestoreCrash('project-intent');
      await saveProjectUnlocked(project.name, await stage.loadProject(project.name));
      await injectRestoreCrash('project-published');
      signal?.throwIfAborted();
    }
    if (revisionRestore) {
      revisionIndexIntentStarted = true;
      await stage.beginRevisionIndexPublish();
      await injectRestoreCrash('revision-index-intent');
      await writeProjectRevisionIndexBytesUnlocked(await stage.loadRevisionIndex());
      await injectRestoreCrash('revision-index-published');
      signal?.throwIfAborted();
    }
    // The final marker is the one commit point: a restart before it rolls
    // every intended live mutation back to its staged pre-image.
    await stage.finalize();
    await injectRestoreCrash('finalized');
  } catch (error) {
    // A fault-injection crash intentionally represents process death, so no
    // in-process cleanup runs. The next startup must use the durable journal.
    if (error instanceof SimulatedBrowserBackupCrash) throw error;
    const rollback = await Promise.allSettled([
      ...stageProjects.map(async (project) => {
        const previous = previousProjects.get(project.name);
        if (previous) await saveProjectUnlocked(project.name, previous);
        else await deleteProjectUnlocked(project.name);
      }),
      ...(revisionIndexIntentStarted ? [stage.rollbackRevisionIndex()] : []),
      ...createdAssets.map((id) => deleteAssetUnlocked(id)),
      ...createdFonts.map((id) => deleteFontUnlocked(id)),
      stage.cleanup(),
    ]);
    const rollbackFailures = rollback.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (rollbackFailures.length > 0) {
      throw new BrowserBackupRecoveryError(error, rollbackFailures);
    }
    throw error;
  }

  try {
    await stage.cleanup();
  } catch {
    // A stale, unreferenced staging namespace is safe and can be reclaimed by
    // a later maintenance pass; the live publish already completed.
  }

  return {
    projects: projects.length,
    assets: assets.length,
    fonts: fonts.length,
    ...(skippedAssetIds.length > 0 ? { skippedAssetIds } : {}),
    ...(skippedFontIds.length > 0 ? { skippedFontIds } : {}),
  };
}

export function restoreBrowserBackup(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<BrowserBackupRestoreResult> {
  return withPersistenceMutationLock(() => restoreBrowserBackupUnlocked(bytes, signal), { signal });
}
