/**
 * Named project revisions: point-in-time snapshots a user can name and return
 * to across sessions.
 *
 * A revision is stored as an ordinary `.szd` under a reserved slot name, so it
 * is covered by the same media garbage collector as any other stored project —
 * the audio a revision references can never be reclaimed while the revision
 * exists. A small JSON index gives each slot its label, its project and its
 * timestamp; if the index is ever lost the slots remain readable projects.
 */

import { isNotFoundError } from './fs-utils';
import { deleteSlotsGuarded } from './guarded-delete';
import { withPersistenceMutationLock } from './mutation-lock';
import {
  deleteProjectUnlocked,
  isOpfsAvailable,
  listProjects,
  loadProject,
  OpfsUnavailableError,
  ProjectAlreadyExistsError,
  ProjectNotFoundError,
  type ProjectRenameHooks,
  sanitizeProjectName,
  saveProjectUnlocked,
} from './opfs';

const REVISIONS_DIR = 'revisions';
const INDEX_FILE = 'index.json';

/** Slot-name prefix marking a stored project as a revision snapshot. */
export const REVISION_SLOT_PREFIX = 'revision-';

/** Revisions kept per project; the oldest are pruned beyond this. */
export const MAX_REVISIONS_PER_PROJECT = 20;

/** Longest accepted revision label. */
export const MAX_REVISION_LABEL_LENGTH = 60;

/** One saved revision. */
export interface ProjectRevision {
  /** Reserved storage slot holding the archive. */
  slot: string;
  /** Project this revision was taken from (sanitized name). */
  projectName: string;
  /** User-supplied label. */
  label: string;
  /** Capture time in epoch milliseconds. */
  savedAt: number;
  /** Archive size in bytes, as measured when it was written. */
  size: number;
}

/** Thrown when a revision label is empty after trimming. */
export class InvalidRevisionLabelError extends Error {
  constructor(label: string) {
    super(`Invalid revision label: "${label}"`);
    this.name = 'InvalidRevisionLabelError';
  }
}

/** Trims and bounds a user label. */
export function sanitizeRevisionLabel(label: string): string {
  const cleaned = label.trim().replace(/\s+/g, ' ').slice(0, MAX_REVISION_LABEL_LENGTH);
  if (cleaned.length === 0) throw new InvalidRevisionLabelError(label);
  return cleaned;
}

/** True when a stored project name is a revision slot rather than a project. */
export function isRevisionSlot(name: string): boolean {
  return name.toLowerCase().startsWith(REVISION_SLOT_PREFIX);
}

async function revisionsDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!isOpfsAvailable()) throw new OpfsUnavailableError();
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(REVISIONS_DIR, { create: true });
}

interface RevisionIndexRead {
  /** Parsed records; malformed records are intentionally omitted. */
  entries: ProjectRevision[];
  /** True only when a readable JSON array was published. */
  usable: boolean;
}

function parseRevisionIndex(raw: unknown): ProjectRevision[] {
  if (!Array.isArray(raw)) return [];
  const entries: ProjectRevision[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.slot !== 'string' ||
      !isRevisionSlot(record.slot) ||
      typeof record.projectName !== 'string' ||
      typeof record.label !== 'string' ||
      typeof record.savedAt !== 'number' ||
      !Number.isFinite(record.savedAt)
    ) {
      continue;
    }
    entries.push({
      slot: record.slot,
      projectName: record.projectName,
      label: record.label,
      savedAt: record.savedAt,
      size: typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : 0,
    });
  }
  return entries;
}

/** Reads the index, dropping malformed records rather than failing the read. */
async function readIndexState(): Promise<RevisionIndexRead> {
  const directory = await revisionsDirectory();
  let raw: unknown;
  try {
    const file = await (await directory.getFileHandle(INDEX_FILE)).getFile();
    raw = JSON.parse(new TextDecoder().decode(await file.arrayBuffer()));
  } catch (error) {
    if (isNotFoundError(error) || error instanceof SyntaxError) {
      // A missing or corrupt index cannot distinguish valid historical slots
      // from an interrupted write. Keep those slots readable for recovery.
      return { entries: [], usable: false };
    }
    throw error;
  }
  if (!Array.isArray(raw)) return { entries: [], usable: false };
  return { entries: parseRevisionIndex(raw), usable: true };
}

async function readIndex(): Promise<ProjectRevision[]> {
  return (await readIndexState()).entries;
}

/** Snapshot of the raw revision store for an enclosing persistence transaction. */
export interface ProjectRevisionStoreSnapshot {
  /** Parsed revision metadata; stale entries are retained when their slot is absent. */
  index: ProjectRevision[];
  /** Every physically stored revision slot, including orphaned slots. */
  slots: ReadonlyMap<string, Uint8Array>;
  /** Original index bytes, or null when the index has never been published. */
  indexBytes: Uint8Array | null;
}

/** Reads the revision store without acquiring the mutation lock. */
export async function readProjectRevisionStoreUnlocked(): Promise<ProjectRevisionStoreSnapshot> {
  const directory = await revisionsDirectory();
  let indexBytes: Uint8Array | null = null;
  try {
    const file = await (await directory.getFileHandle(INDEX_FILE)).getFile();
    indexBytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  const slots = new Map<string, Uint8Array>();
  for (const project of await listProjects()) {
    if (!isRevisionSlot(project.name)) continue;
    try {
      slots.set(project.name, await loadProject(project.name));
    } catch (error) {
      // A slot can disappear between listProjects() and loadProject(). The
      // index remains useful even when one of its old payloads is missing.
      if (!(error instanceof ProjectNotFoundError)) throw error;
    }
  }
  return { index: await readIndex(), slots, indexBytes };
}

/** Publishes raw index bytes while the caller owns the mutation lock. */
export async function writeProjectRevisionIndexBytesUnlocked(bytes: Uint8Array): Promise<void> {
  const directory = await revisionsDirectory();
  const handle = await directory.getFileHandle(INDEX_FILE, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(new Uint8Array(bytes));
    await writable.close();
  } catch (error) {
    try {
      await writable.abort?.();
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

/** Removes the revision index while the caller owns the mutation lock. */
export async function deleteProjectRevisionIndexUnlocked(): Promise<void> {
  const directory = await revisionsDirectory();
  try {
    await directory.removeEntry(INDEX_FILE);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

async function writeIndex(entries: readonly ProjectRevision[]): Promise<void> {
  await writeProjectRevisionIndexBytesUnlocked(new TextEncoder().encode(JSON.stringify(entries)));
}

/**
 * Prepares revision-index hooks for an enclosing project rename transaction.
 *
 * The caller invokes the returned hooks while the project copy is already
 * present and the old project still exists. Keeping the old index snapshot in
 * the rollback closure prevents a failed source delete from orphaning the
 * revision records under the old name.
 */
export async function prepareProjectRename(
  oldName: string,
  newName: string,
): Promise<ProjectRenameHooks> {
  const from = sanitizeProjectName(oldName);
  const to = sanitizeProjectName(newName);
  if (from === to) return {};

  const entries = await readIndex();
  if (entries.some((entry) => entry.projectName === to)) {
    throw new ProjectAlreadyExistsError(to);
  }
  const renamed = entries.map((entry) =>
    entry.projectName === from ? { ...entry, projectName: to } : entry,
  );
  if (entries.every((entry, index) => entry === renamed[index])) return {};
  return {
    beforeSourceDelete: () => writeIndex(renamed),
    rollback: () => writeIndex(entries),
  };
}

/**
 * Updates revision ownership after a project slot has already been moved.
 * Normal project renames use {@link prepareProjectRename} through
 * {@link renameProject} so the index update participates in the byte move
 * transaction. This entry point is for recovery/migration callers that have
 * moved the project bytes themselves.
 */
export async function renameProjectRevisions(oldName: string, newName: string): Promise<number> {
  return withPersistenceMutationLock(() => renameProjectRevisionsUnlocked(oldName, newName));
}

/** Updates revision ownership without acquiring the mutation lock. */
export async function renameProjectRevisionsUnlocked(
  oldName: string,
  newName: string,
): Promise<number> {
  const from = sanitizeProjectName(oldName);
  const to = sanitizeProjectName(newName);
  if (from === to) return 0;
  const entries = await readIndex();
  if (entries.some((entry) => entry.projectName === to)) {
    throw new ProjectAlreadyExistsError(to);
  }
  const renamed = entries.map((entry) =>
    entry.projectName === from ? { ...entry, projectName: to } : entry,
  );
  const changed = entries.filter((entry) => entry.projectName === from).length;
  if (changed === 0) return 0;
  await writeIndex(renamed);
  return changed;
}

/**
 * Lists revisions, newest first.
 *
 * @param projectName Limits the result to one project; omit for all of them.
 */
export async function listProjectRevisions(projectName?: string): Promise<ProjectRevision[]> {
  const entries = await readIndex();
  const wanted = projectName === undefined ? undefined : sanitizeProjectName(projectName);
  return entries
    .filter((entry) => wanted === undefined || entry.projectName === wanted)
    .sort((a, b) => b.savedAt - a.savedAt);
}

/** Allocates a slot name that no stored project or index entry uses yet. */
function nextSlot(taken: ReadonlySet<string>, savedAt: number): string {
  const base = `${REVISION_SLOT_PREFIX}${savedAt.toString(36)}`;
  let candidate = base;
  let counter = 1;
  while (taken.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

/** Reads a revision slot when present, retaining null for stale index entries. */
async function readOptionalProjectSlot(slot: string): Promise<Uint8Array | null> {
  try {
    return await loadProject(slot);
  } catch (error) {
    if (error instanceof ProjectNotFoundError) return null;
    throw error;
  }
}

/** Restores slot pre-images captured before a revision transaction. */
async function restoreProjectSlots(
  images: readonly { slot: string; bytes: Uint8Array | null }[],
): Promise<void> {
  for (const image of images) {
    if (image.bytes === null) await deleteProjectUnlocked(image.slot);
    else await saveProjectUnlocked(image.slot, image.bytes);
  }
}

/**
 * Saves a labelled snapshot of a project's archive bytes.
 *
 * @param projectName Project the snapshot belongs to.
 * @param label User-supplied label (trimmed, bounded).
 * @param bytes Archive bytes, as produced for a normal save.
 * @param savedAt Capture time in epoch milliseconds.
 * @returns The stored revision record.
 */
export function saveProjectRevision(
  projectName: string,
  label: string,
  bytes: Uint8Array,
  savedAt: number,
): Promise<ProjectRevision> {
  return withPersistenceMutationLock(() =>
    saveProjectRevisionUnlocked(projectName, label, bytes, savedAt),
  );
}

/** Saves a labelled revision while the caller owns the mutation lock. */
export async function saveProjectRevisionUnlocked(
  projectName: string,
  label: string,
  bytes: Uint8Array,
  savedAt: number,
): Promise<ProjectRevision> {
  const project = sanitizeProjectName(projectName);
  const cleanLabel = sanitizeRevisionLabel(label);
  const index = await readIndexState();
  const entries = index.entries;
  const stored = await listProjects();
  const taken = new Set([
    ...entries.map((entry) => entry.slot),
    ...stored.map((info) => info.name),
  ]);
  const revision: ProjectRevision = {
    slot: nextSlot(taken, savedAt),
    projectName: project,
    label: cleanLabel,
    savedAt,
    size: bytes.byteLength,
  };
  const next = [...entries, revision];
  // Prune this project's oldest generations; other projects are untouched.
  const mine = next
    .filter((entry) => entry.projectName === project)
    .sort((a, b) => b.savedAt - a.savedAt);
  const dropped = mine.slice(MAX_REVISIONS_PER_PROJECT);
  const droppedSlots = new Set(dropped.map((entry) => entry.slot));
  const published = next.filter((entry) => !droppedSlots.has(entry.slot));
  const droppedImages = await Promise.all(
    dropped.map(async (entry) => ({
      slot: entry.slot,
      bytes: await readOptionalProjectSlot(entry.slot),
    })),
  );

  let revisionPublished = false;
  const deletedCleanup: typeof droppedImages = [];
  try {
    await saveProjectUnlocked(revision.slot, bytes);
    await writeIndex(published);
    revisionPublished = true;
    // Only slots the readable index named are pruned; unindexed slots may be the only copy of a history.
    const imageBySlot = new Map(droppedImages.map((image) => [image.slot, image]));
    await deleteSlotsGuarded({
      inventoryRead: index.usable,
      candidates: imageBySlot.keys(),
      retained: new Set(published.map((entry) => entry.slot)),
      remove: async (slot) => {
        deletedCleanup.push(imageBySlot.get(slot) as (typeof droppedImages)[number]);
        await deleteProjectUnlocked(slot);
      },
    });
  } catch (error) {
    // Restore the old index and any pruned bytes before removing the newly
    // written slot. Every operation stays inside this lock, so no observer
    // can interleave a conflicting revision transaction during rollback.
    if (revisionPublished) {
      try {
        await restoreProjectSlots(deletedCleanup);
      } catch {
        // Preserve the original failure; a later pass can retry the repair.
      }
    }
    try {
      await writeIndex(entries);
    } catch {
      // Preserve the original failure; the previous index is still the
      // recoverable source of truth when the underlying write is transient.
    }
    try {
      await deleteProjectUnlocked(revision.slot);
    } catch {
      // Preserve the original failure; the slot remains readable for repair.
    }
    throw error;
  }
  return revision;
}

/**
 * Reads a revision's archive bytes.
 *
 * @param slot Revision slot from {@link listProjectRevisions}.
 */
export function loadProjectRevision(slot: string): Promise<Uint8Array> {
  return loadProject(slot);
}

/** Deletes one revision and its index entry. Unknown slots are a no-op. */
export function deleteProjectRevision(slot: string): Promise<void> {
  return withPersistenceMutationLock(() => deleteProjectRevisionUnlocked(slot));
}

/** Deletes one revision while the caller owns the mutation lock. */
export async function deleteProjectRevisionUnlocked(slot: string): Promise<void> {
  const entries = await readIndex();
  if (!entries.some((entry) => entry.slot === slot)) return;
  const existingBytes = await readOptionalProjectSlot(slot);
  const next = entries.filter((entry) => entry.slot !== slot);
  let indexPublished = false;
  try {
    await writeIndex(next);
    indexPublished = true;
    await deleteProjectUnlocked(slot);
  } catch (error) {
    // If the slot delete failed after index publication, restore both pieces.
    // A missing slot is already represented by the new index and needs no
    // byte pre-image.
    if (existingBytes !== null) {
      try {
        await saveProjectUnlocked(slot, existingBytes);
      } catch {
        // Preserve the original deletion failure; a later pass can retry.
      }
    }
    if (indexPublished || !isNotFoundError(error)) {
      try {
        await writeIndex(entries);
      } catch {
        // Preserve the original deletion failure.
      }
    }
    throw error;
  }
}

/** Drops every revision of a project (used when the project itself is deleted). */
export function deleteProjectRevisions(projectName: string): Promise<number> {
  return withPersistenceMutationLock(() => deleteProjectRevisionsUnlocked(projectName));
}

/** Drops every revision while the caller owns the mutation lock. */
export async function deleteProjectRevisionsUnlocked(projectName: string): Promise<number> {
  const project = sanitizeProjectName(projectName);
  const entries = await readIndex();
  const mine = entries.filter((entry) => entry.projectName === project);
  if (mine.length === 0) return 0;
  const images = await Promise.all(
    mine.map(async (entry) => ({
      slot: entry.slot,
      bytes: await readOptionalProjectSlot(entry.slot),
    })),
  );
  const next = entries.filter((entry) => entry.projectName !== project);
  let indexPublished = false;
  const deleted: typeof images = [];
  try {
    await writeIndex(next);
    indexPublished = true;
    for (const image of images) {
      deleted.push(image);
      await deleteProjectUnlocked(image.slot);
    }
  } catch (error) {
    if (indexPublished) {
      try {
        await restoreProjectSlots(deleted);
      } catch {
        // Preserve the original deletion failure; a later pass can retry.
      }
    }
    try {
      await writeIndex(entries);
    } catch {
      // Preserve the original deletion failure.
    }
    throw error;
  }
  return mine.length;
}
