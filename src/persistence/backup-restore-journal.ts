/**
 * Crash-safe staging journal for browser backup restores.
 *
 * A restore stages incoming archives and rollback pre-images in an OPFS
 * directory and records publish intents before each live-namespace mutation,
 * so an interrupted restore can be rolled back on the next run.
 */

import { deleteAssetUnlocked } from '@/persistence/assets';
import {
  createRandomId,
  isNotFoundError,
  isStringArray,
  writeOpfsFile,
} from '@/persistence/fs-utils';
import { withPersistenceMutationLock } from '@/persistence/mutation-lock';
import {
  deleteProjectUnlocked,
  projectBytesRevision,
  saveProjectUnlocked,
} from '@/persistence/opfs';
import {
  deleteProjectRevisionIndexUnlocked,
  writeProjectRevisionIndexBytesUnlocked,
} from '@/persistence/revisions';
import { deleteFontUnlocked } from '@/project/fonts';

const RESTORE_STAGING_DIR = 'restore-staging';
const RESTORE_MANIFEST_FILE = 'manifest.json';

interface BrowserRestoreStage {
  loadProject(name: string): Promise<Uint8Array>;
  loadRevisionIndex(): Promise<Uint8Array>;
  /** Write-ahead intent records make a crashed publish safe to roll back. */
  beginProjectPublish(name: string): Promise<void>;
  beginAssetPublish(id: string): Promise<void>;
  beginFontPublish(id: string): Promise<void>;
  beginRevisionIndexPublish(): Promise<void>;
  rollbackRevisionIndex(): Promise<void>;
  finalize(): Promise<void>;
  cleanup(): Promise<void>;
}

interface BrowserRestoreStageProject {
  name: string;
  file: string;
  revision: string;
  /** Absent when the restore creates a previously nonexistent project. */
  previousFile?: string;
}

interface BrowserRestoreStageManifest {
  version: 2;
  /** `publishing` is a durable rollback point; `finalized` commits the restore. */
  state: 'prepared' | 'publishing' | 'finalized';
  projects: BrowserRestoreStageProject[];
  assetIds: string[];
  fontIds: string[];
  projectPublishIntents: string[];
  assetPublishIntents: string[];
  fontPublishIntents: string[];
  revisionIndexFile?: string;
  previousRevisionIndexFile?: string;
  revisionIndexPublishIntent?: boolean;
}

export async function prepareBrowserRestoreStage(
  projects: readonly { name: string; bytes: Uint8Array }[],
  previousProjects: ReadonlyMap<string, Uint8Array | null>,
  assetIds: readonly string[],
  fontIds: readonly string[],
  revisionIndex: { bytes: Uint8Array; previousBytes: Uint8Array | null } | undefined,
  signal?: AbortSignal,
): Promise<BrowserRestoreStage> {
  const root = await navigator.storage.getDirectory();
  const stagingRoot = await root.getDirectoryHandle(RESTORE_STAGING_DIR, { create: true });
  const transactionId = createRandomId();
  const directory = await stagingRoot.getDirectoryHandle(transactionId, { create: true });
  // Namespace incoming archives separately from rollback pre-images. A user
  // project named `previous-X` must never collide with the pre-image for `X`.
  const fileName = (name: string): string => `incoming-${encodeURIComponent(name)}.szd`;
  const previousFileName = (name: string): string => `previous-${encodeURIComponent(name)}.szd`;
  const revisionIndexFileName = 'incoming-revisions-index.json';
  const previousRevisionIndexFileName = 'previous-revisions-index.json';
  const cleanup = (): Promise<void> => stagingRoot.removeEntry(transactionId, { recursive: true });
  let manifest!: BrowserRestoreStageManifest;
  try {
    for (const project of projects) {
      signal?.throwIfAborted();
      await writeOpfsFile(directory, fileName(project.name), project.bytes);
      const previous = previousProjects.get(project.name);
      if (previous) await writeOpfsFile(directory, previousFileName(project.name), previous);
    }
    if (revisionIndex) {
      await writeOpfsFile(directory, revisionIndexFileName, revisionIndex.bytes);
      if (revisionIndex.previousBytes) {
        await writeOpfsFile(directory, previousRevisionIndexFileName, revisionIndex.previousBytes);
      }
    }
    manifest = {
      version: 2,
      state: 'prepared',
      projects: projects.map((project) => ({
        name: project.name,
        file: fileName(project.name),
        revision: projectBytesRevision(project.bytes),
        ...(previousProjects.get(project.name)
          ? { previousFile: previousFileName(project.name) }
          : {}),
      })),
      assetIds: [...assetIds],
      fontIds: [...fontIds],
      projectPublishIntents: [],
      assetPublishIntents: [],
      fontPublishIntents: [],
      ...(revisionIndex
        ? {
            revisionIndexFile: revisionIndexFileName,
            ...(revisionIndex.previousBytes
              ? { previousRevisionIndexFile: previousRevisionIndexFileName }
              : {}),
          }
        : {}),
    };
    // The manifest is the staging publish marker and is deliberately written
    // only after every incoming project archive is durable.
    await writeOpfsFile(
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
  const writeManifest = (manifest: BrowserRestoreStageManifest): Promise<void> =>
    writeOpfsFile(
      directory,
      RESTORE_MANIFEST_FILE,
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
  const addIntent = async (
    field: 'projectPublishIntents' | 'assetPublishIntents' | 'fontPublishIntents',
    id: string,
  ): Promise<void> => {
    if (manifest[field].includes(id)) return;
    // This write is deliberately before the corresponding live-namespace
    // mutation. A restart can therefore restore every project that may have
    // changed, even if the tab dies between the mutation and its completion.
    manifest.state = 'publishing';
    manifest[field].push(id);
    await writeManifest(manifest);
  };
  return {
    async loadProject(name): Promise<Uint8Array> {
      const file = await (await directory.getFileHandle(fileName(name))).getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    async loadRevisionIndex(): Promise<Uint8Array> {
      if (!revisionIndex) throw new Error('Browser backup has no revision index');
      return readStageFile(directory, revisionIndexFileName);
    },
    beginProjectPublish: (name) => addIntent('projectPublishIntents', name),
    beginAssetPublish: (id) => addIntent('assetPublishIntents', id),
    beginFontPublish: (id) => addIntent('fontPublishIntents', id),
    async beginRevisionIndexPublish(): Promise<void> {
      if (!revisionIndex) return;
      manifest.state = 'publishing';
      manifest.revisionIndexPublishIntent = true;
      await writeManifest(manifest);
    },
    async rollbackRevisionIndex(): Promise<void> {
      if (!revisionIndex) return;
      if (revisionIndex.previousBytes) {
        await writeProjectRevisionIndexBytesUnlocked(revisionIndex.previousBytes);
      } else {
        await deleteProjectRevisionIndexUnlocked();
      }
    },
    async finalize(): Promise<void> {
      manifest.state = 'finalized';
      await writeManifest(manifest);
    },
    cleanup,
  };
}

async function readStageFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<Uint8Array> {
  const file = await (await directory.getFileHandle(name)).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

function isRecoverableRestoreStageManifest(value: unknown): value is BrowserRestoreStageManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<BrowserRestoreStageManifest>;
  if (
    manifest.version !== 2 ||
    (manifest.state !== 'prepared' &&
      manifest.state !== 'publishing' &&
      manifest.state !== 'finalized') ||
    !Array.isArray(manifest.projects) ||
    !isStringArray(manifest.assetIds) ||
    !isStringArray(manifest.fontIds) ||
    !isStringArray(manifest.projectPublishIntents) ||
    !isStringArray(manifest.assetPublishIntents) ||
    !isStringArray(manifest.fontPublishIntents) ||
    (manifest.revisionIndexFile !== undefined && typeof manifest.revisionIndexFile !== 'string') ||
    (manifest.previousRevisionIndexFile !== undefined &&
      typeof manifest.previousRevisionIndexFile !== 'string') ||
    (manifest.revisionIndexPublishIntent !== undefined &&
      typeof manifest.revisionIndexPublishIntent !== 'boolean')
  ) {
    return false;
  }
  return manifest.projects.every(
    (project): project is BrowserRestoreStageProject =>
      !!project &&
      typeof project.name === 'string' &&
      typeof project.file === 'string' &&
      typeof project.revision === 'string' &&
      (project.previousFile === undefined || typeof project.previousFile === 'string'),
  );
}

/** Rolls an interrupted restore back to the complete pre-restore project set. */
async function rollbackRestoreStage(
  directory: FileSystemDirectoryHandle,
  manifest: BrowserRestoreStageManifest,
): Promise<void> {
  const byName = new Map(manifest.projects.map((project) => [project.name, project]));
  for (const name of manifest.projectPublishIntents) {
    const project = byName.get(name);
    if (!project) continue;
    if (project.previousFile) {
      await saveProjectUnlocked(name, await readStageFile(directory, project.previousFile));
    } else {
      try {
        await deleteProjectUnlocked(name);
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    }
  }
  if (manifest.revisionIndexPublishIntent) {
    if (manifest.previousRevisionIndexFile) {
      await writeProjectRevisionIndexBytesUnlocked(
        await readStageFile(directory, manifest.previousRevisionIndexFile),
      );
    } else {
      await deleteProjectRevisionIndexUnlocked();
    }
  }
  // Assets and SoundFonts are additive during a backup restore. Intent records
  // identify only content created by this interrupted transaction.
  await Promise.all(
    [
      ...manifest.assetPublishIntents.map((id) => deleteAssetUnlocked(id)),
      ...manifest.fontPublishIntents.map((id) => deleteFontUnlocked(id)),
    ].map(async (operation) => {
      try {
        await operation;
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    }),
  );
}

/**
 * Recovers restore-staging namespaces orphaned by a crashed restore. A restore
 * that finishes — whether it publishes or cleanly rolls back — always removes
 * its own staging directory. A `publishing` journal is rolled back from the
 * durable pre-image; a `finalized` journal is already committed and is simply
 * reclaimed.
 *
 * Restore holds the persistence mutation lock, so no staging directory can be
 * live when this runs under that lock: every one present is reclaimable. Called
 * at the start of each restore, and exported so a startup maintenance pass can
 * reclaim orphans without waiting for the next restore.
 *
 * @returns The number of orphaned staging namespaces removed.
 */
export async function reclaimOrphanedRestoreStages(): Promise<number> {
  const root = await navigator.storage.getDirectory();
  let stagingRoot: FileSystemDirectoryHandle;
  try {
    stagingRoot = await root.getDirectoryHandle(RESTORE_STAGING_DIR);
  } catch {
    // No staging root has ever been created; nothing to reclaim.
    return 0;
  }
  // Directory iteration is not specified to remain stable when entries are
  // removed. Snapshot the stage names before deleting any so one orphan cannot
  // make the next one invisible until a later startup pass.
  const stageNames: string[] = [];
  for await (const [name, handle] of stagingRoot.entries()) {
    if (handle.kind === 'directory') stageNames.push(name);
  }
  let reclaimed = 0;
  for (const name of stageNames) {
    try {
      const stage = await stagingRoot.getDirectoryHandle(name);
      const parsed: unknown = JSON.parse(
        new TextDecoder().decode(await readStageFile(stage, RESTORE_MANIFEST_FILE)),
      );
      if (isRecoverableRestoreStageManifest(parsed) && parsed.state === 'publishing') {
        await rollbackRestoreStage(stage, parsed);
      }
      await stagingRoot.removeEntry(name, { recursive: true });
      reclaimed += 1;
    } catch {
      // Leave it for a later pass rather than aborting the whole sweep.
    }
  }
  return reclaimed;
}

/** Reclaims crashed-restore staging directories during application startup. */
export function reclaimOrphanedRestoreStagesAtStartup(): Promise<number> {
  return withPersistenceMutationLock(() => reclaimOrphanedRestoreStages());
}
