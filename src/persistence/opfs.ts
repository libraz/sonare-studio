/**
 * OPFS (origin-private file system) storage for project files.
 *
 * Projects are stored as "<name>.szd" files inside a "projects/" directory of
 * the origin-private root. This module only moves bytes; encoding/decoding
 * lives in src/persistence/szd.ts. Every call resolves the directory handle
 * fresh, so environments without OPFS fail with a typed
 * {@link OpfsUnavailableError} the UI can present.
 */

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

/** True when this environment exposes the origin-private file system. */
export function isOpfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
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
    .replace(/\.szd$/i, '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are unsafe in filenames
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_')
    .trim();
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
    throw new InvalidProjectNameError(name);
  }
  return cleaned;
}

/** True when an error is a DOMException-style NotFoundError. */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'NotFoundError'
  );
}

/** Resolves (creating on demand) the "projects/" directory handle. */
async function projectsDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!isOpfsAvailable()) throw new OpfsUnavailableError();
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(PROJECTS_DIR, { create: true });
}

/**
 * Writes project bytes to OPFS, replacing any previous file of the same name.
 *
 * @param name Project name; sanitized, ".szd" is appended.
 * @param bytes Archive bytes (from encodeSzd); copied before writing.
 */
export async function saveProject(name: string, bytes: Uint8Array): Promise<void> {
  const fileName = sanitizeProjectName(name) + FILE_EXTENSION;
  const dir = await projectsDirectory();
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  try {
    // Copy so wasm-backed or shared buffers are never handed to the stream.
    await writable.write(new Uint8Array(bytes));
  } finally {
    await writable.close();
  }
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

/**
 * Lists the stored projects, sorted by name.
 *
 * @returns Name (without extension), size and last-modified time per project.
 */
export async function listProjects(): Promise<StoredProjectInfo[]> {
  const dir = await projectsDirectory();
  const out: StoredProjectInfo[] = [];
  for await (const [entryName, handle] of dir.entries()) {
    if (handle.kind !== 'file' || !entryName.endsWith(FILE_EXTENSION)) continue;
    const file = await handle.getFile();
    const info: StoredProjectInfo = {
      name: entryName.slice(0, -FILE_EXTENSION.length),
      size: file.size,
    };
    if (Number.isFinite(file.lastModified)) info.lastModified = file.lastModified;
    out.push(info);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Deletes a stored project. Deleting a name that is not stored is a no-op,
 * so callers can treat deletion as idempotent.
 *
 * @param name Project name (sanitized the same way as on save).
 */
export async function deleteProject(name: string): Promise<void> {
  const safeName = sanitizeProjectName(name);
  const dir = await projectsDirectory();
  try {
    await dir.removeEntry(`${safeName}${FILE_EXTENSION}`);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
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
  await saveProject(to, bytes);
  await deleteProject(from);
}
