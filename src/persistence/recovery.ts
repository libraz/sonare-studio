import { createRandomId, writeOpfsFile } from './fs-utils';
import { deleteSlotsGuarded } from './guarded-delete';
import { withPersistenceMutationLock } from './mutation-lock';
import {
  AUTOSAVE_SESSION_SLOT_PREFIX,
  AUTOSAVE_SLOT,
  deleteProjectUnlocked,
  listProjectNames,
  listProjects,
  loadProject,
  projectBytesRevision,
  saveProjectUnlocked,
} from './opfs';
import { decodeSzdWithMetaInWorker } from './szd';

const RECOVERY_DIR = 'recovery';
const MANIFEST_FILE = 'autosave-manifest.json';
const SESSION_KEY = 'sonare-studio:autosave-session:v1';
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
const claimedSessionIds = new Set<string>();

function createSessionId(): string {
  return createRandomId().replace(/[^A-Za-z0-9._-]/g, '-');
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

function renewSessionId(): void {
  const created = createSessionId();
  fallbackSessionId = created;
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(SESSION_KEY, created);
  } catch {
    // Sandboxed/private contexts may expose sessionStorage but reject access.
  }
}

/** Holds a tab-lifetime Web Lock on the id; false when another live tab already owns it. */
function acquireSessionLock(locks: LockManager, sessionId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    void locks.request(`${SESSION_KEY}:${sessionId}`, { ifAvailable: true }, (lock) => {
      resolve(lock !== null);
      return lock === null ? undefined : new Promise<void>(() => {});
    });
  });
}

/**
 * Resolves this tab's autosave session id, replacing it when a duplicated tab
 * inherited an id that another live tab already holds.
 */
async function claimAutosaveSessionId(): Promise<string> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  let sessionId = autosaveSessionId();
  if (!locks || claimedSessionIds.has(sessionId)) return sessionId;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await acquireSessionLock(locks, sessionId)) break;
    renewSessionId();
    sessionId = autosaveSessionId();
  }
  claimedSessionIds.add(sessionId);
  return sessionId;
}

export function isAutosaveRecoverySlot(name: string): boolean {
  return name.toLowerCase().startsWith(AUTOSAVE_SESSION_SLOT_PREFIX);
}

function sessionSlot(sessionId: string): string {
  return `${AUTOSAVE_SESSION_SLOT_PREFIX}${sessionId}`;
}

async function recoveryDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(RECOVERY_DIR, { create: true });
}

/** `trusted` is true only when the manifest file parsed and validated. */
async function readManifest(): Promise<{ manifest: RecoveryManifest; trusted: boolean }> {
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
    return { manifest: { version: 1, sessions }, trusted: true };
  } catch {
    return { manifest: { version: 1, sessions: [] }, trusted: false };
  }
}

async function writeManifest(manifest: RecoveryManifest): Promise<void> {
  await writeOpfsFile(
    await recoveryDirectory(),
    MANIFEST_FILE,
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
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
    const sessionId = await claimAutosaveSessionId();
    const slot = sessionSlot(sessionId);
    await saveProjectUnlocked(slot, bytes);

    const { manifest, trusted } = await readManifest();
    const next: RecoveryManifestEntry = {
      sessionId,
      slot,
      documentRevision: documentRevision(documentKey),
      archiveRevision: projectBytesRevision(bytes),
      savedAt,
    };
    const known = trusted ? manifest.sessions : await rebuildSessionEntries(slot);
    const merged = [next, ...known.filter((entry) => entry.sessionId !== sessionId)].sort((a, b) =>
      b.savedAt.localeCompare(a.savedAt),
    );
    // An unreadable manifest must not shrink the set: every on-disk slot stays listed.
    const sessions = trusted ? merged.slice(0, MAX_SESSION_REVISIONS) : merged;
    await writeManifest({ version: 1, sessions });

    const retained = new Set(sessions.map((entry) => entry.slot));
    await deleteSlotsGuarded({
      inventoryRead: trusted,
      candidates: (await listProjectNames()).filter((name) => isAutosaveRecoverySlot(name)),
      retained,
      remove: deleteProjectUnlocked,
    });
  });
}

/** Rebuilds manifest entries for every on-disk session slot other than `exclude`. */
async function rebuildSessionEntries(exclude: string): Promise<RecoveryManifestEntry[]> {
  const entries: RecoveryManifestEntry[] = [];
  for (const info of await listProjects()) {
    if (!isAutosaveRecoverySlot(info.name) || info.name === exclude) continue;
    try {
      entries.push({
        sessionId: info.name.slice(AUTOSAVE_SESSION_SLOT_PREFIX.length),
        slot: info.name,
        documentRevision: '',
        archiveRevision: projectBytesRevision(await loadProject(info.name)),
        savedAt: new Date(info.lastModified ?? 0).toISOString(),
      });
    } catch {
      // An unreadable slot cannot be listed, and it is never deleted while the manifest is untrusted.
    }
  }
  return entries;
}

/**
 * Loads the newest valid autosave across the shared slot and all per-session
 * revisions. A save publishes the shared archive before its session manifest;
 * treating the session copy as unconditionally preferred would silently roll
 * back the newest edit if the tab crashed in that interval.
 */
export function loadLatestAutosaveSessionRevision(): Promise<Uint8Array | null> {
  return withPersistenceMutationLock(async () => {
    const { manifest } = await readManifest();
    const listed = (await listProjects())
      .filter((info) => isAutosaveRecoverySlot(info.name))
      .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
    const manifestBySlot = new Map(manifest.sessions.map((entry) => [entry.slot, entry]));
    const modifiedAtBySlot = new Map(listed.map((info) => [info.name, info.lastModified ?? 0]));
    const candidates = new Set([
      AUTOSAVE_SLOT,
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
