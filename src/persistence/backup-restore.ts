/**
 * Browser backup restore: validates the archive against its inventory, plans
 * an additive revision merge, then publishes through a durable restore stage
 * that rolls every live mutation back on failure.
 */

import { strToU8 } from 'fflate';
import { errorMessage } from '@/lib/errors';
import { preflightAndUnzipInWorker } from '@/persistence/archive-preflight';
import { deleteAssetUnlocked, saveAssetWithStatusUnlocked } from '@/persistence/assets';
import {
  ASSETS_PREFIX,
  BACKUP_APP_ID,
  BACKUP_KIND,
  BACKUP_VERSION,
  type BrowserBackupInventory,
  type BrowserBackupInventoryItem,
  type BrowserBackupMeta,
  FONTS_PREFIX,
  inventoryBytes,
  META_ENTRY,
  payloadChecksum,
  projectNameFromEntry,
  REVISION_INDEX_ENTRY,
  revisionSlotFromEntry,
  revisionSlotFromProjectEntry,
} from '@/persistence/backup-archive-layout';
import {
  prepareBrowserRestoreStage,
  reclaimOrphanedRestoreStages,
} from '@/persistence/backup-restore-journal';
import {
  audioFromPreparedAssetRestore,
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
  loadProject,
  ProjectNotFoundError,
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
import { deleteFontUnlocked, saveFontWithStatusUnlocked } from '@/project/fonts';

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
    const reason = errorMessage(restoreError);
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

function parseJson<T>(bytes: Uint8Array): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
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

type BackupEntries = Record<string, Uint8Array>;
type BackupPayload = { name: string; bytes: Uint8Array };
type BrowserRestoreStage = Awaited<ReturnType<typeof prepareBrowserRestoreStage>>;

/** Cumulative nested-expansion allowance shared by every nested archive decode. */
interface BackupExpansionBudget {
  expandedBytes: number;
  entries: number;
}

/** Parses and validates the backup manifest, including its inventory when versioned. */
function validateBackupMeta(entries: BackupEntries): void {
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
}

/** Decodes a nested archive against the cumulative budget, consuming it. */
function consumeExpansionBudget(
  data: Uint8Array,
  budget: BackupExpansionBudget,
  exhaustedMessage: string,
): void {
  if (budget.expandedBytes <= 0 || budget.entries <= 0) throw new Error(exhaustedMessage);
  const decoded = decodeSzdWithResourceReport(data, {
    maxEntries: budget.entries,
    maxEntryBytes: Math.min(MAX_PROJECT_ARCHIVE_ENTRY_BYTES, budget.expandedBytes),
    maxUncompressedBytes: budget.expandedBytes,
  });
  budget.expandedBytes -= decoded.report.uncompressedBytes;
  budget.entries -= decoded.report.entries;
}

/** Collects the nested project archives, enforcing name and expansion limits. */
function collectBackupProjects(
  entries: BackupEntries,
  budget: BackupExpansionBudget,
  signal?: AbortSignal,
): BackupPayload[] {
  const projects: BackupPayload[] = [];
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
    consumeExpansionBudget(
      data,
      budget,
      'Browser backup nested project expansion exceeds the cumulative budget',
    );
    projects.push({ name, bytes: data });
  }
  return projects;
}

/** Collects the nested revision slot archives, enforcing uniqueness and expansion limits. */
function collectBackupRevisionSlots(
  entries: BackupEntries,
  budget: BackupExpansionBudget,
  signal?: AbortSignal,
): BackupPayload[] {
  const revisionSlots: BackupPayload[] = [];
  const revisionSlotNames = new Set<string>();
  for (const [entryName, data] of Object.entries(entries)) {
    signal?.throwIfAborted();
    const slot = revisionSlotFromEntry(entryName) ?? revisionSlotFromProjectEntry(entryName);
    if (slot === null) continue;
    if (revisionSlotNames.has(slot)) invalidBackup();
    consumeExpansionBudget(
      data,
      budget,
      'Browser backup nested revision expansion exceeds the cumulative budget',
    );
    revisionSlotNames.add(slot);
    revisionSlots.push({ name: slot, bytes: data });
  }
  return revisionSlots;
}

/** Lists the sorted, well-formed media ids under an archive prefix. */
function backupMediaIds(
  entries: BackupEntries,
  prefix: string,
  payloadExtension: string,
): string[] {
  return [
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
}

/** Prepares asset and font restores, skipping incomplete or unreadable entries. */
function prepareBackupMedia(entries: BackupEntries): {
  assets: PreparedAssetRestore[];
  fonts: PreparedFontRestore[];
  skippedAssetIds: string[];
  skippedFontIds: string[];
} {
  const skippedAssetIds: string[] = [];
  const assets: PreparedAssetRestore[] = [];
  for (const id of backupMediaIds(entries, ASSETS_PREFIX, '.pcm')) {
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
  for (const id of backupMediaIds(entries, FONTS_PREFIX, '.sf2')) {
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
  return { assets, fonts, skippedAssetIds, skippedFontIds };
}

/** Preflights media restores and returns the ids already present locally. */
async function findExistingBackupMedia(
  assets: PreparedAssetRestore[],
  fonts: PreparedFontRestore[],
  signal?: AbortSignal,
): Promise<{ existingAssets: Set<string>; existingFonts: Set<string> }> {
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
  return { existingAssets, existingFonts };
}

/** Reads each project's current bytes (null when absent) as its rollback pre-image. */
async function loadPreviousProjects(
  stageProjects: BackupPayload[],
  signal?: AbortSignal,
): Promise<Map<string, Uint8Array | null>> {
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
  return previousProjects;
}

/** Publishes the staged live mutations in order, then commits the stage. */
async function publishBrowserRestore(
  stage: BrowserRestoreStage,
  plan: {
    assets: PreparedAssetRestore[];
    fonts: PreparedFontRestore[];
    existingAssets: Set<string>;
    existingFonts: Set<string>;
    stageProjects: BackupPayload[];
    revisionRestore: unknown;
  },
  progress: {
    createdAssets: string[];
    createdFonts: string[];
    markRevisionIndexIntentStarted: () => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const { assets, fonts, existingAssets, existingFonts, stageProjects, revisionRestore } = plan;
  const { createdAssets, createdFonts } = progress;
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
    progress.markRevisionIndexIntentStarted();
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
  const budget: BackupExpansionBudget = {
    expandedBytes: MAX_BACKUP_TOTAL_EXPANDED_BYTES - outerArchive.report.uncompressedBytes,
    entries: MAX_BACKUP_ARCHIVE_ENTRIES - outerArchive.report.entries,
  };
  validateBackupMeta(entries);

  const projects = collectBackupProjects(entries, budget, signal);

  const revisionIndexBytes = entries[REVISION_INDEX_ENTRY];
  const archiveRevisionIndex = revisionIndexBytes
    ? parseRevisionIndex(revisionIndexBytes)
    : undefined;
  const revisionSlots = collectBackupRevisionSlots(entries, budget, signal);

  const { assets, fonts, skippedAssetIds, skippedFontIds } = prepareBackupMedia(entries);

  const { existingAssets, existingFonts } = await findExistingBackupMedia(assets, fonts, signal);
  const existingRevisionStore = await readProjectRevisionStoreUnlocked();
  const revisionPlan = planRevisionRestore(
    archiveRevisionIndex,
    revisionSlots,
    existingRevisionStore,
  );
  const stageProjects = [...projects, ...revisionPlan.slotsToPublish];
  const previousProjects = await loadPreviousProjects(stageProjects, signal);

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
    await publishBrowserRestore(
      stage,
      { assets, fonts, existingAssets, existingFonts, stageProjects, revisionRestore },
      {
        createdAssets,
        createdFonts,
        markRevisionIndexIntentStarted: () => {
          revisionIndexIntentStarted = true;
        },
      },
      signal,
    );
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
