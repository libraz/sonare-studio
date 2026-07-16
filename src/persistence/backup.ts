/**
 * Whole-browser backup archive for OPFS-hosted sonare data.
 *
 * A .szd project export is intentionally project-scoped. This archive is the
 * broader safety net for browser-only storage: every saved project slot, every
 * shared audio asset and every SoundFont is packed into one zip so a user can
 * recover after clearing site data or moving to a new browser profile.
 */

import { AsyncZipDeflate, strToU8, Zip } from 'fflate';
import { preflightAndUnzipInWorker } from '@/persistence/archive-preflight';
import {
  deleteAssetUnlocked,
  interleaveChannels,
  listAssets,
  loadAsset,
  saveAssetWithStatusUnlocked,
} from '@/persistence/assets';
import {
  collectReferencedAssetIds,
  collectReferencedFontIds,
  preflightAssetRestore,
  preflightFontRestore,
  prepareAssetRestore,
  prepareFontRestore,
} from '@/persistence/bundle';
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

export const BROWSER_BACKUP_FILE_EXTENSION = '.sonare-backup.zip';

const BACKUP_VERSION = 2;
const BACKUP_APP_ID = 'sonare-studio';
const BACKUP_KIND = 'browser-backup';
const META_ENTRY = 'meta.json';
const PROJECTS_PREFIX = 'projects/';
const ASSETS_PREFIX = 'assets/';
const FONTS_PREFIX = 'fonts/';
const MEDIA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESTORE_STAGING_DIR = 'restore-staging';
const RESTORE_MANIFEST_FILE = 'manifest.json';

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
}

interface BrowserBackupMeta {
  app: string;
  kind: string;
  version: number;
  savedAt: string;
  projects: number;
  assets: number;
  fonts: number;
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

interface BrowserRestoreStage {
  loadProject(name: string): Promise<Uint8Array>;
  cleanup(): Promise<void>;
}

async function writeStageFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(new Uint8Array(bytes));
    await writable.close();
  } catch (error) {
    try {
      await writable.abort?.();
    } catch {
      // Preserve the original staging failure.
    }
    throw error;
  }
}

async function prepareBrowserRestoreStage(
  projects: readonly { name: string; bytes: Uint8Array }[],
  assetIds: readonly string[],
  fontIds: readonly string[],
  signal?: AbortSignal,
): Promise<BrowserRestoreStage> {
  const root = await navigator.storage.getDirectory();
  const stagingRoot = await root.getDirectoryHandle(RESTORE_STAGING_DIR, { create: true });
  const transactionId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const directory = await stagingRoot.getDirectoryHandle(transactionId, { create: true });
  const fileName = (name: string): string => `${encodeURIComponent(name)}.szd`;
  const cleanup = (): Promise<void> => stagingRoot.removeEntry(transactionId, { recursive: true });
  try {
    for (const project of projects) {
      signal?.throwIfAborted();
      await writeStageFile(directory, fileName(project.name), project.bytes);
    }
    const manifest = {
      version: 1,
      state: 'prepared',
      projects: projects.map((project) => ({
        name: project.name,
        file: fileName(project.name),
        revision: projectBytesRevision(project.bytes),
      })),
      assetIds,
      fontIds,
    };
    // The manifest is the staging publish marker and is deliberately written
    // only after every incoming project archive is durable.
    await writeStageFile(
      directory,
      RESTORE_MANIFEST_FILE,
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
  } catch (error) {
    try {
      await cleanup();
    } catch {
      // No live namespace points at an incompletely prepared stage.
    }
    throw error;
  }
  return {
    async loadProject(name): Promise<Uint8Array> {
      const file = await (await directory.getFileHandle(fileName(name))).getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    cleanup,
  };
}

/** Raw interleaved-PCM bytes view of planar channels (a fresh copy). */
function pcmBytes(channels: ReadonlyArray<Float32Array>): Uint8Array {
  const interleaved = interleaveChannels(channels);
  return new Uint8Array(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength).slice();
}

function projectEntryName(name: string): string {
  return `${PROJECTS_PREFIX}${encodeURIComponent(name)}.szd`;
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

function concatZipChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function payloadChecksum(...parts: readonly Uint8Array[]): string {
  return parts.map((part) => projectBytesRevision(part)).join(':');
}

function inventoryBytes(
  inventory: Omit<BrowserBackupInventory, 'complete' | 'totalBytes'>,
): number {
  return [...inventory.projects, ...inventory.assets, ...inventory.fonts].reduce(
    (total, item) => total + item.bytes,
    0,
  );
}

function createBackupZipWriter(
  savedAt: string,
  signal?: AbortSignal,
  limits: BrowserBackupExportLimits = DEFAULT_EXPORT_LIMITS,
): {
  add(name: string, bytes: Uint8Array): void;
  abort(): void;
  close(): Promise<Uint8Array>;
  stats(): { entries: number; uncompressedBytes: number };
} {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let entries = 0;
  let uncompressedBytes = 0;
  let failed = false;
  let resolveResult!: (bytes: Uint8Array) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<Uint8Array>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const zip = new Zip((error, chunk, final) => {
    if (failed) return;
    if (error) {
      failed = true;
      rejectResult(error);
      return;
    }
    const copy = new Uint8Array(chunk);
    chunks.push(copy);
    totalBytes += copy.byteLength;
    if (totalBytes > limits.maxCompressedBytes) {
      failed = true;
      zip.terminate();
      rejectResult(
        new BrowserBackupSizeError('Browser backup compressed size exceeds its restore limit'),
      );
      return;
    }
    if (final) resolveResult(concatZipChunks(chunks, totalBytes));
  });
  return {
    abort(): void {
      if (failed) return;
      failed = true;
      zip.terminate();
    },
    add(name, bytes): void {
      signal?.throwIfAborted();
      const byteLength = bytes.byteLength;
      if (byteLength > limits.maxEntryBytes) {
        throw new BrowserBackupSizeError(
          `Browser backup entry "${name}" exceeds its restore limit`,
        );
      }
      if (entries + 1 > limits.maxEntries) {
        throw new BrowserBackupSizeError('Browser backup entry count exceeds its restore limit');
      }
      if (uncompressedBytes + byteLength > limits.maxOuterExpandedBytes) {
        throw new BrowserBackupSizeError('Browser backup expanded size exceeds its restore limit');
      }
      const file = new AsyncZipDeflate(name, { level: 6 });
      file.mtime = new Date(savedAt);
      zip.add(file);
      file.push(bytes, true);
      entries += 1;
      uncompressedBytes += byteLength;
    },
    async close(): Promise<Uint8Array> {
      try {
        signal?.throwIfAborted();
        zip.end();
        return await result;
      } catch (error) {
        zip.terminate();
        throw error;
      }
    },
    stats(): { entries: number; uncompressedBytes: number } {
      return { entries, uncompressedBytes };
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
    const inventory = { projects: [], assets: [], fonts: [] } as Omit<
      BrowserBackupInventory,
      'complete' | 'totalBytes'
    >;
    const documents: ProjectDocument[] = [];
    const nested = { entries: 0, uncompressedBytes: 0 };

    for (const project of await listProjects()) {
      if (isReservedProjectName(project.name)) continue;
      signal?.throwIfAborted();
      const bytes = await loadProject(project.name);
      const decoded = decodeSzdWithResourceReport(bytes, {});
      documents.push(decoded.document);
      nested.entries += decoded.report.entries;
      nested.uncompressedBytes += decoded.report.uncompressedBytes;
      const payloadBytes = bytes.byteLength;
      const checksum = payloadChecksum(bytes);
      zip.add(projectEntryName(project.name), bytes);
      assertNestedBackupBudget(zip.stats(), nested, limits);
      inventory.projects.push({
        id: project.name,
        bytes: payloadBytes,
        checksum,
      });
    }

    const successfulAssets = new Set<string>();
    const assetFailures = new Map<string, unknown>();
    for (const asset of await listAssets()) {
      try {
        const loaded = await loadAsset(asset.id);
        signal?.throwIfAborted();
        const meta = strToU8(JSON.stringify(loaded.meta));
        const pcm = pcmBytes(loaded.channels);
        const payloadBytes = meta.byteLength + pcm.byteLength;
        const checksum = payloadChecksum(meta, pcm);
        zip.add(`${ASSETS_PREFIX}${asset.id}.json`, meta);
        zip.add(`${ASSETS_PREFIX}${asset.id}.pcm`, pcm);
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
        zip.add(`${FONTS_PREFIX}${font.id}.json`, meta);
        zip.add(`${FONTS_PREFIX}${font.id}.sf2`, sf2);
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

    const issues: MediaCompletenessIssue[] = [];
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
      inventory: {
        complete: completeness.complete,
        totalBytes: inventoryBytes(inventory),
        ...inventory,
      },
    };
    zip.add(META_ENTRY, strToU8(JSON.stringify(meta)));
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
  };
  if (
    meta.projects !== expected.projects.length ||
    meta.assets !== expected.assets.length ||
    meta.fonts !== expected.fonts.length
  ) {
    invalidBackup();
  }

  const knownEntries = new Set([META_ENTRY]);
  const actual = { projects: [], assets: [], fonts: [] } as Omit<
    BrowserBackupInventory,
    'complete' | 'totalBytes'
  >;
  for (const [entryName, data] of Object.entries(entries)) {
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
  if (raw.totalBytes !== inventoryBytes(actual)) invalidBackup();
}

/** Restores a browser backup as one preflighted, rollback-capable transaction. */
async function restoreBrowserBackupUnlocked(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<BrowserBackupRestoreResult> {
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

  const assets = Object.entries(entries).flatMap(([entryName, data]) => {
    if (!entryName.startsWith(ASSETS_PREFIX) || !entryName.endsWith('.pcm')) return [];
    const id = entryName.slice(ASSETS_PREFIX.length, -'.pcm'.length);
    if (!MEDIA_ID_PATTERN.test(id)) return [];
    const metaBytes = entries[`${ASSETS_PREFIX}${id}.json`];
    if (!metaBytes) return [];
    try {
      return [prepareAssetRestore({ id, meta: metaBytes, pcm: data })];
    } catch {
      return [];
    }
  });
  const fonts = Object.entries(entries).flatMap(([entryName, data]) => {
    if (!entryName.startsWith(FONTS_PREFIX) || !entryName.endsWith('.sf2')) return [];
    const id = entryName.slice(FONTS_PREFIX.length, -'.sf2'.length);
    if (!MEDIA_ID_PATTERN.test(id)) return [];
    const metaBytes = entries[`${FONTS_PREFIX}${id}.json`];
    if (!metaBytes) return [];
    try {
      return [prepareFontRestore({ id, meta: metaBytes, sf2: data })];
    } catch {
      return [];
    }
  });

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
  const previousProjects = new Map<string, Uint8Array | null>();
  for (const project of projects) {
    try {
      previousProjects.set(project.name, await loadProject(project.name));
      signal?.throwIfAborted();
    } catch (error) {
      if (error instanceof ProjectNotFoundError) previousProjects.set(project.name, null);
      else throw error;
    }
  }

  const stage = await prepareBrowserRestoreStage(
    projects,
    assets.map((entry) => entry.id),
    fonts.map((entry) => entry.id),
    signal,
  );

  const createdAssets: string[] = [];
  const createdFonts: string[] = [];
  try {
    for (const entry of assets) {
      if (existingAssets.has(entry.id)) continue;
      createdAssets.push(entry.id);
      await saveAssetWithStatusUnlocked(
        {
          id: entry.id,
          name: entry.meta.name,
          sampleRate: entry.meta.sampleRate,
          numChannels: entry.meta.numChannels,
          ...(entry.meta.tags ? { tags: entry.meta.tags } : {}),
        },
        entry.audio,
      );
      signal?.throwIfAborted();
    }
    for (const entry of fonts) {
      if (existingFonts.has(entry.id)) continue;
      createdFonts.push(entry.id);
      await saveFontWithStatusUnlocked({ id: entry.id, name: entry.meta.name }, entry.data);
      signal?.throwIfAborted();
    }
    for (const project of projects) {
      await saveProjectUnlocked(project.name, await stage.loadProject(project.name));
      signal?.throwIfAborted();
    }
  } catch (error) {
    const rollback = await Promise.allSettled([
      ...projects.map(async (project) => {
        const previous = previousProjects.get(project.name);
        if (previous) await saveProjectUnlocked(project.name, previous);
        else await deleteProjectUnlocked(project.name);
      }),
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

  return { projects: projects.length, assets: assets.length, fonts: fonts.length };
}

export function restoreBrowserBackup(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<BrowserBackupRestoreResult> {
  return withPersistenceMutationLock(() => restoreBrowserBackupUnlocked(bytes, signal), { signal });
}
