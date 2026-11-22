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
import { listAssets, readAssetPcmBytes } from '@/persistence/assets';
import {
  ASSETS_PREFIX,
  BACKUP_APP_ID,
  BACKUP_KIND,
  BACKUP_VERSION,
  type BrowserBackupInventory,
  type BrowserBackupMeta,
  FONTS_PREFIX,
  inventoryBytes,
  META_ENTRY,
  payloadChecksum,
  projectEntryName,
  REVISION_INDEX_ENTRY,
  revisionEntryName,
} from '@/persistence/backup-archive-layout';
import { collectReferencedAssetIds, collectReferencedFontIds } from '@/persistence/bundle';
import { withPersistenceMutationLock } from '@/persistence/mutation-lock';
import { isReservedProjectName, listProjects, loadProject } from '@/persistence/opfs';
import {
  MAX_BACKUP_ARCHIVE_COMPRESSED_BYTES,
  MAX_BACKUP_ARCHIVE_ENTRIES,
  MAX_BACKUP_ARCHIVE_ENTRY_BYTES,
  MAX_BACKUP_OUTER_EXPANDED_BYTES,
  MAX_BACKUP_TOTAL_EXPANDED_BYTES,
} from '@/persistence/resource-limits';
import { readProjectRevisionStoreUnlocked } from '@/persistence/revisions';
import { decodeSzdWithResourceReport } from '@/persistence/szd';
import { listFonts, loadFont } from '@/project/fonts';
import {
  createMediaCompletenessReport,
  type MediaCompletenessIssue,
  type MediaCompletenessReport,
  mediaFailureIssues,
} from '@/project/media-completeness';
import type { ProjectDocument } from '@/project/serialization';

export {
  BrowserBackupRecoveryError,
  type BrowserBackupRestoreFaultPoint,
  type BrowserBackupRestoreResult,
  restoreBrowserBackup,
  setBrowserBackupRestoreFaultInjectorForTests,
} from '@/persistence/backup-restore';
export {
  reclaimOrphanedRestoreStages,
  reclaimOrphanedRestoreStagesAtStartup,
} from '@/persistence/backup-restore-journal';

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
