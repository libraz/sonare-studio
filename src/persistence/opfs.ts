/**
 * OPFS (origin-private file system) storage for project files.
 *
 * Projects are stored as "<name>.szd" files inside a "projects/" directory of
 * the origin-private root. This module only moves bytes; encoding/decoding
 * lives in src/persistence/szd.ts. Every call resolves the directory handle
 * fresh, so environments without OPFS fail with a typed
 * {@link OpfsUnavailableError} the UI can present.
 */

import { isNotFoundError, isQuotaExceededError, writeOpfsFile } from './fs-utils';
import { withPersistenceMutationLock } from './mutation-lock';
import { prepareProjectRename } from './revisions';

/** Directory under the OPFS root that holds the project files. */
const PROJECTS_DIR = 'projects';

/** File extension appended to stored project names. */
const FILE_EXTENSION = '.szd';

/** Thrown when the environment exposes no OPFS (navigator.storage.getDirectory). */
export class OpfsUnavailableError extends Error {
  constructor() {
    super('Project storage is unavailable: this browser does not support the origin file system');
    this.name = 'OpfsUnavailableError';
  }
}

/** Thrown when an OPFS project write runs out of origin storage quota. */
export class OpfsQuotaExceededError extends Error {
  constructor() {
    super('Project storage is full. Free browser storage space and try saving again.');
    this.name = 'OpfsQuotaExceededError';
  }
}

/** Thrown when a stored project with the requested name does not exist. */
export class ProjectNotFoundError extends Error {
  constructor(name: string) {
    super(`No stored project named "${name}"`);
    this.name = 'ProjectNotFoundError';
  }
}

/** Thrown when a rename would overwrite a different stored project. */
export class ProjectAlreadyExistsError extends Error {
  constructor(name: string) {
    super(`A stored project named "${name}" already exists`);
    this.name = 'ProjectAlreadyExistsError';
  }
}

/** Thrown when another tab changed a named project after the caller loaded it. */
export class ProjectRevisionConflictError extends Error {
  constructor(readonly projectName: string) {
    super(`Stored project "${projectName}" changed in another window; reopen it before saving`);
    this.name = 'ProjectRevisionConflictError';
  }
}

/** Thrown when a project name is empty (or empties out) after sanitization. */
export class InvalidProjectNameError extends Error {
  constructor(name: string) {
    super(`Invalid project name: "${name}"`);
    this.name = 'InvalidProjectNameError';
  }
}

/** One stored project as reported by {@link listProjects}. */
export interface StoredProjectInfo {
  /** Sanitized project name (without the .szd extension). */
  name: string;
  /** File size in bytes. */
  size: number;
  /** Last-modified time in epoch milliseconds, when the platform reports one. */
  lastModified?: number;
}

export interface StoredProjectSnapshot {
  bytes: Uint8Array;
  revision: string;
}

/** Optional metadata hooks for a project rename transaction. */
export interface ProjectRenameHooks {
  /** Publishes related metadata while the old project still exists. */
  beforeSourceDelete?: () => Promise<void>;
  /** Restores metadata when publication or source deletion fails. */
  rollback?: () => Promise<void>;
}

/** Content revision used for compare-and-swap named saves. */
export function projectBytesRevision(bytes: Uint8Array): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  // Indexed typed-array access stays on the fast path for multi-megabyte
  // archives; `for…of` creates an iterator step for every byte.
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    first = Math.imul(first ^ byte, 0x01000193) >>> 0;
    second = Math.imul(second ^ byte, 0x85ebca6b) >>> 0;
  }
  return `${bytes.byteLength.toString(36)}-${first.toString(16).padStart(8, '0')}${second
    .toString(16)
    .padStart(8, '0')}`;
}

/** True when this environment exposes the origin-private file system. */
export function isOpfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

/**
 * Asks the browser to mark this origin's storage as persistent so the OPFS
 * projects, assets and fonts are not silently evicted under storage pressure.
 *
 * Best-effort: returns the granted state, or false when the Storage API or
 * `persist()` is unavailable or throws. Safe to call once at startup; the
 * grant is sticky, so a repeat call is cheap and idempotent.
 *
 * @returns True when storage is (now or already) persistent.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (typeof storage?.persist !== 'function') return false;
  try {
    if (typeof storage.persisted === 'function') {
      try {
        if (await storage.persisted()) return true;
      } catch {
        // Some browsers expose persisted() but reject it in private or
        // restricted contexts. Still try persist(); it may be the only usable
        // signal for this origin.
      }
    }
    return await storage.persist();
  } catch {
    return false;
  }
}

/**
 * Sanitizes a project name into a safe file base name (no extension).
 *
 * A trailing ".szd" is dropped, filesystem-unsafe characters become "_" and
 * surrounding whitespace is trimmed (same character policy as the MIDI export
 * filenames).
 *
 * @throws InvalidProjectNameError when nothing usable remains.
 */
export function sanitizeProjectName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/\.szd$/i, '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are unsafe in filenames
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_')
    .trim();
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
    throw new InvalidProjectNameError(name);
  }
  return cleaned;
}

/** Slot-name prefix marking a stored project as a revision snapshot. */
export const REVISION_SLOT_PREFIX = 'revision-';

/** Slot name of the shared autosave snapshot. */
export const AUTOSAVE_SLOT = 'autosave';

/** Slot-name prefix of the per-session autosave snapshots. */
export const AUTOSAVE_SESSION_SLOT_PREFIX = 'autosave-session-';

/** True when a stored name is an autosave slot (the crash-recovery snapshot). */
export function isAutosaveProjectName(name: string): boolean {
  const sanitized = sanitizeProjectName(name).toLowerCase();
  return sanitized === AUTOSAVE_SLOT || sanitized.startsWith(AUTOSAVE_SESSION_SLOT_PREFIX);
}

/**
 * True when a sanitized project name is reserved for internal storage slots.
 * Reserved slots are real stored projects — which keeps them inside the media
 * garbage collector's reference scan — but never appear in the project list.
 */
export function isReservedProjectName(name: string): boolean {
  const sanitized = sanitizeProjectName(name).toLowerCase();
  return isAutosaveProjectName(sanitized) || sanitized.startsWith(REVISION_SLOT_PREFIX);
}

/**
 * Resolves (creating on demand) a top-level OPFS directory handle.
 *
 * @throws OpfsUnavailableError when the environment exposes no OPFS.
 */
export async function opfsDirectory(name: string): Promise<FileSystemDirectoryHandle> {
  if (!isOpfsAvailable()) throw new OpfsUnavailableError();
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

/** Resolves (creating on demand) the "projects/" directory handle. */
function projectsDirectory(): Promise<FileSystemDirectoryHandle> {
  return opfsDirectory(PROJECTS_DIR);
}

/**
 * Writes project bytes to OPFS, replacing any previous file of the same name.
 *
 * @param name Project name; sanitized, ".szd" is appended.
 * @param bytes Archive bytes (from encodeSzd); copied before writing.
 */
export async function saveProjectUnlocked(name: string, bytes: Uint8Array): Promise<void> {
  const fileName = sanitizeProjectName(name) + FILE_EXTENSION;
  const dir = await projectsDirectory();
  try {
    await writeOpfsFile(dir, fileName, bytes);
  } catch (error) {
    if (isQuotaExceededError(error)) throw new OpfsQuotaExceededError();
    throw error;
  }
}

export function saveProject(name: string, bytes: Uint8Array): Promise<void> {
  return withPersistenceMutationLock(() => saveProjectUnlocked(name, bytes));
}

/**
 * Reads a stored project's bytes from OPFS.
 *
 * @param name Project name (sanitized the same way as on save).
 * @returns The stored archive bytes.
 * @throws ProjectNotFoundError when no such project is stored.
 */
export async function loadProject(name: string): Promise<Uint8Array> {
  const safeName = sanitizeProjectName(name);
  const dir = await projectsDirectory();
  let file: File;
  try {
    const handle = await dir.getFileHandle(`${safeName}${FILE_EXTENSION}`);
    file = await handle.getFile();
  } catch (error) {
    if (isNotFoundError(error)) throw new ProjectNotFoundError(safeName);
    throw error;
  }
  return new Uint8Array(await file.arrayBuffer());
}

export async function loadProjectWithRevision(name: string): Promise<StoredProjectSnapshot> {
  const bytes = await loadProject(name);
  return { bytes, revision: projectBytesRevision(bytes) };
}

/**
 * Writes only when the stored revision still matches the caller's baseline.
 * `null` requires a new slot; `undefined` preserves unconditional legacy saves.
 */
export function saveProjectChecked(
  name: string,
  bytes: Uint8Array,
  expectedRevision: string | null | undefined,
): Promise<string> {
  const safeName = sanitizeProjectName(name);
  return withPersistenceMutationLock(async () => {
    if (expectedRevision !== undefined) {
      let currentRevision: string | null = null;
      try {
        currentRevision = projectBytesRevision(await loadProject(safeName));
      } catch (error) {
        if (!(error instanceof ProjectNotFoundError)) throw error;
      }
      if (currentRevision !== expectedRevision) {
        throw new ProjectRevisionConflictError(safeName);
      }
    }
    await saveProjectUnlocked(safeName, bytes);
    return projectBytesRevision(bytes);
  });
}

async function projectFileEntries(): Promise<Array<[string, FileSystemFileHandle]>> {
  const dir = await projectsDirectory();
  const entries: Array<[string, FileSystemFileHandle]> = [];
  for await (const [entryName, handle] of dir.entries()) {
    if (handle.kind === 'file' && entryName.endsWith(FILE_EXTENSION))
      entries.push([entryName, handle]);
  }
  return entries;
}

/**
 * Lists the stored project names without opening the files, sorted by name.
 *
 * @returns Project names without the extension.
 */
export async function listProjectNames(): Promise<string[]> {
  return (await projectFileEntries())
    .map(([entryName]) => entryName.slice(0, -FILE_EXTENSION.length))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Lists the stored projects, sorted by name.
 *
 * @returns Name (without extension), size and last-modified time per project.
 */
export async function listProjects(): Promise<StoredProjectInfo[]> {
  const entries = await projectFileEntries();
  const out = await Promise.all(
    entries.map(async ([entryName, handle]): Promise<StoredProjectInfo> => {
      const file = await handle.getFile();
      const info: StoredProjectInfo = {
        name: entryName.slice(0, -FILE_EXTENSION.length),
        size: file.size,
      };
      if (Number.isFinite(file.lastModified)) info.lastModified = file.lastModified;
      return info;
    }),
  );
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Deletes a stored project. Deleting a name that is not stored is a no-op,
 * so callers can treat deletion as idempotent.
 *
 * @param name Project name (sanitized the same way as on save).
 */
export async function deleteProjectUnlocked(name: string): Promise<void> {
  const safeName = sanitizeProjectName(name);
  const dir = await projectsDirectory();
  try {
    await dir.removeEntry(`${safeName}${FILE_EXTENSION}`);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

export function deleteProject(name: string): Promise<void> {
  return withPersistenceMutationLock(() => deleteProjectUnlocked(name));
}

/**
 * Renames a stored project (copy + delete; OPFS has no portable move).
 *
 * @param oldName Current project name.
 * @param newName Desired project name.
 * @throws ProjectNotFoundError when the source does not exist.
 * @throws ProjectAlreadyExistsError when a different project already uses the
 *   new name.
 */
export async function renameProject(oldName: string, newName: string): Promise<void> {
  return withPersistenceMutationLock(async () => {
    const from = sanitizeProjectName(oldName);
    const to = sanitizeProjectName(newName);
    if (from === to) return;
    // The revision index lives in a separate module to keep the raw project
    // store independent. Read its rename hooks only after acquiring the same
    // mutation lock, so the project bytes and metadata commit as one unit.
    await renameProjectUnlocked(from, to, await prepareProjectRename(from, to));
  });
}

export async function renameProjectUnlocked(
  oldName: string,
  newName: string,
  hooks?: ProjectRenameHooks,
): Promise<void> {
  const from = sanitizeProjectName(oldName);
  const to = sanitizeProjectName(newName);
  if (from === to) return;
  const dir = await projectsDirectory();
  try {
    await dir.getFileHandle(`${to}${FILE_EXTENSION}`);
    throw new ProjectAlreadyExistsError(to);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  const bytes = await loadProject(from);
  try {
    await saveProjectUnlocked(to, bytes);
  } catch (error) {
    // The writable stream may have created a partial destination before it
    // failed. The destination was verified absent above, so it is safe to
    // remove it while leaving the source untouched.
    try {
      await deleteProjectUnlocked(to);
    } catch {
      // Preserve the original copy failure.
    }
    throw error;
  }
  try {
    await hooks?.beforeSourceDelete?.();
    await deleteProjectUnlocked(from);
  } catch (error) {
    // The source should still exist when metadata publication fails. If the
    // delete itself failed after partially taking effect, restore its bytes
    // from the copy before removing the destination.
    try {
      await hooks?.rollback?.();
    } catch {
      // Preserve the original rename failure; a later persistence pass can
      // retry the metadata repair.
    }
    try {
      await loadProject(from);
    } catch (sourceError) {
      if (sourceError instanceof ProjectNotFoundError) {
        try {
          await saveProjectUnlocked(from, bytes);
        } catch {
          // Preserve the original rename failure.
        }
      }
    }
    try {
      await deleteProjectUnlocked(to);
    } catch {
      // Preserve the original rename failure.
    }
    throw error;
  }
}
