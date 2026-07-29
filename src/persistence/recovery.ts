import { withPersistenceMutationLock } from './mutation-lock';
import {
  deleteProjectUnlocked,
  listProjects,
  loadProject,
  projectBytesRevision,
  saveProjectUnlocked,
} from './opfs';
import { decodeSzdWithMetaInWorker } from './szd';

const RECOVERY_DIR = 'recovery';
const MANIFEST_FILE = 'autosave-manifest.json';
const SESSION_KEY = 'sonare-studio:autosave-session:v1';
const SLOT_PREFIX = 'autosave-session-';
const MAX_SESSION_REVISIONS = 8;

interface RecoveryManifestEntry {
  sessionId: string;
  slot: string;
  documentRevision: string;
  archiveRevision: string;
  savedAt: string;
}

interface RecoveryManifest {
  version: 1;
  sessions: RecoveryManifestEntry[];
}

let fallbackSessionId: string | null = null;

function createSessionId(): string {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return id.replace(/[^A-Za-z0-9._-]/g, '-');
}

export function autosaveSessionId(): string {
  if (typeof sessionStorage !== 'undefined') {
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (stored) return stored;
      const created = createSessionId();
      sessionStorage.setItem(SESSION_KEY, created);
      return created;
    } catch {
      // Sandboxed/private contexts may expose sessionStorage but reject access.
    }
  }
  fallbackSessionId ??= createSessionId();
  return fallbackSessionId;
}

export function isAutosaveRecoverySlot(name: string): boolean {
  return name.toLowerCase().startsWith(SLOT_PREFIX);
}

function sessionSlot(sessionId: string): string {
  return `${SLOT_PREFIX}${sessionId}`;
}

async function recoveryDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(RECOVERY_DIR, { create: true });
}

async function readManifest(): Promise<RecoveryManifest> {
  try {
    const handle = await (await recoveryDirectory()).getFileHandle(MANIFEST_FILE);
    const file = await handle.getFile();
    const parsed = JSON.parse(
      new TextDecoder().decode(await file.arrayBuffer()),
    ) as Partial<RecoveryManifest>;
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions))
      throw new Error('invalid manifest');
    const sessions = parsed.sessions.filter(
      (entry): entry is RecoveryManifestEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.sessionId === 'string' &&
        typeof entry.slot === 'string' &&
        isAutosaveRecoverySlot(entry.slot) &&
        typeof entry.documentRevision === 'string' &&
        typeof entry.archiveRevision === 'string' &&
        typeof entry.savedAt === 'string',
    );
    return { version: 1, sessions };
  } catch {
    return { version: 1, sessions: [] };
  }
}

async function writeManifest(manifest: RecoveryManifest): Promise<void> {
  const handle = await (await recoveryDirectory()).getFileHandle(MANIFEST_FILE, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(new TextEncoder().encode(JSON.stringify(manifest)));
    await writable.close();
  } catch (error) {
    try {
      await writable.abort?.();
    } catch {
      // Preserve the original manifest write failure.
    }
    throw error;
  }
}

function documentRevision(documentKey: string): string {
  return projectBytesRevision(new TextEncoder().encode(documentKey));
}

/** Persists one tab's autosave independently and publishes its revision manifest entry. */
export function saveAutosaveSessionRevision(
  bytes: Uint8Array,
  documentKey: string,
  savedAt = new Date().toISOString(),
): Promise<void> {
  return withPersistenceMutationLock(async () => {
    const sessionId = autosaveSessionId();
    const slot = sessionSlot(sessionId);
    await saveProjectUnlocked(slot, bytes);

    const manifest = await readManifest();
    const next: RecoveryManifestEntry = {
      sessionId,
      slot,
      documentRevision: documentRevision(documentKey),
      archiveRevision: projectBytesRevision(bytes),
      savedAt,
    };
    const sessions = [next, ...manifest.sessions.filter((entry) => entry.sessionId !== sessionId)]
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
      .slice(0, MAX_SESSION_REVISIONS);
    await writeManifest({ version: 1, sessions });

    const retained = new Set(sessions.map((entry) => entry.slot));
    for (const info of await listProjects()) {
      if (isAutosaveRecoverySlot(info.name) && !retained.has(info.name)) {
        await deleteProjectUnlocked(info.name);
      }
    }
  });
}

/**
 * Loads the newest valid autosave across the shared slot and all per-session
 * revisions. A save publishes the shared archive before its session manifest;
 * treating the session copy as unconditionally preferred would silently roll
 * back the newest edit if the tab crashed in that interval.
 */
export function loadLatestAutosaveSessionRevision(): Promise<Uint8Array | null> {
  return withPersistenceMutationLock(async () => {
    const manifest = await readManifest();
    const listed = (await listProjects())
      .filter((info) => isAutosaveRecoverySlot(info.name))
      .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
    const manifestBySlot = new Map(manifest.sessions.map((entry) => [entry.slot, entry]));
    const modifiedAtBySlot = new Map(listed.map((info) => [info.name, info.lastModified ?? 0]));
    const candidates = new Set([
      'autosave',
      ...manifest.sessions.map((entry) => entry.slot),
      ...listed.map((info) => info.name),
    ]);
    let newest: { bytes: Uint8Array; savedAt: number } | null = null;
    for (const slot of candidates) {
      try {
        const bytes = await loadProject(slot);
        const entry = manifestBySlot.get(slot);
        if (entry && projectBytesRevision(bytes) !== entry.archiveRevision) continue;
        // A valid archive revision alone is insufficient: schema changes or a
        // partially written payload can still fail to decode. Decode each
        // candidate off the main thread and reuse that one ZIP expansion for
        // its advisory saved timestamp.
        const decoded = await decodeSzdWithMetaInWorker(bytes);
        const savedAt =
          Date.parse(entry?.savedAt ?? decoded.meta?.savedAt ?? '') ||
          modifiedAtBySlot.get(slot) ||
          0;
        if (!newest || savedAt > newest.savedAt) newest = { bytes, savedAt };
      } catch {
        // Try the next independently-written session revision.
      }
    }
    return newest?.bytes ?? null;
  });
}
