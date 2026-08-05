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
import {
  deleteProject,
  isOpfsAvailable,
  listProjects,
  loadProject,
  OpfsUnavailableError,
  sanitizeProjectName,
  saveProject,
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

/** Reads the index, dropping malformed records rather than failing the read. */
async function readIndex(): Promise<ProjectRevision[]> {
  const directory = await revisionsDirectory();
  let raw: unknown;
  try {
    const file = await (await directory.getFileHandle(INDEX_FILE)).getFile();
    raw = JSON.parse(new TextDecoder().decode(await file.arrayBuffer()));
  } catch (error) {
    if (isNotFoundError(error) || error instanceof SyntaxError) return [];
    throw error;
  }
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

async function writeIndex(entries: readonly ProjectRevision[]): Promise<void> {
  const directory = await revisionsDirectory();
  const handle = await directory.getFileHandle(INDEX_FILE, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(new TextEncoder().encode(JSON.stringify(entries)));
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

/**
 * Saves a labelled snapshot of a project's archive bytes.
 *
 * @param projectName Project the snapshot belongs to.
 * @param label User-supplied label (trimmed, bounded).
 * @param bytes Archive bytes, as produced for a normal save.
 * @param savedAt Capture time in epoch milliseconds.
 * @returns The stored revision record.
 */
export async function saveProjectRevision(
  projectName: string,
  label: string,
  bytes: Uint8Array,
  savedAt: number,
): Promise<ProjectRevision> {
  const project = sanitizeProjectName(projectName);
  const cleanLabel = sanitizeRevisionLabel(label);
  const entries = await readIndex();
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
  await saveProject(revision.slot, bytes);
  const next = [...entries, revision];
  // Prune this project's oldest generations; other projects are untouched.
  const mine = next
    .filter((entry) => entry.projectName === project)
    .sort((a, b) => b.savedAt - a.savedAt);
  const dropped = mine.slice(MAX_REVISIONS_PER_PROJECT);
  const droppedSlots = new Set(dropped.map((entry) => entry.slot));
  await writeIndex(next.filter((entry) => !droppedSlots.has(entry.slot)));
  for (const entry of dropped) {
    try {
      await deleteProject(entry.slot);
    } catch {
      // A slot that is already gone still leaves the index consistent.
    }
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
export async function deleteProjectRevision(slot: string): Promise<void> {
  const entries = await readIndex();
  if (!entries.some((entry) => entry.slot === slot)) return;
  await writeIndex(entries.filter((entry) => entry.slot !== slot));
  try {
    await deleteProject(slot);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

/** Drops every revision of a project (used when the project itself is deleted). */
export async function deleteProjectRevisions(projectName: string): Promise<number> {
  const project = sanitizeProjectName(projectName);
  const entries = await readIndex();
  const mine = entries.filter((entry) => entry.projectName === project);
  if (mine.length === 0) return 0;
  await writeIndex(entries.filter((entry) => entry.projectName !== project));
  for (const entry of mine) {
    try {
      await deleteProject(entry.slot);
    } catch {
      // Keep deleting the rest; the index no longer references this slot.
    }
  }
  return mine.length;
}
