import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listProjects, saveProject } from '@/persistence/opfs';
import {
  loadLatestAutosaveSessionRevision,
  saveAutosaveSessionRevision,
} from '@/persistence/recovery';
import { encodeSzd } from '@/persistence/szd';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from '@/project/serialization';
import { installMockOpfs, type MemoryDirectoryHandle, uninstallMockOpfs } from './opfs-mock';

const SESSION_KEY = 'sonare-studio:autosave-session:v1';

function archive(name: string, savedAt?: string): Uint8Array {
  const doc: ProjectDocument = {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name,
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [],
    markers: [],
    sections: [],
  };
  return encodeSzd(doc, { savedAt });
}

describe('per-session autosave recovery', () => {
  let root: MemoryDirectoryHandle;

  beforeEach(() => {
    sessionStorage.clear();
    root = installMockOpfs();
  });

  afterEach(() => {
    sessionStorage.clear();
    uninstallMockOpfs();
  });

  it('keeps independent tab revisions and restores the newest valid one', async () => {
    const first = archive('A');
    const second = archive('B');
    sessionStorage.setItem(SESSION_KEY, 'tab-a');
    await saveAutosaveSessionRevision(first, '{"name":"A"}', '2026-07-16T00:00:00.000Z');
    sessionStorage.setItem(SESSION_KEY, 'tab-b');
    await saveAutosaveSessionRevision(second, '{"name":"B"}', '2026-07-16T00:01:00.000Z');

    expect((await listProjects()).map((entry) => entry.name)).toEqual([
      'autosave-session-tab-a',
      'autosave-session-tab-b',
    ]);
    await expect(loadLatestAutosaveSessionRevision()).resolves.toEqual(second);

    const projects = await root.getDirectoryHandle('projects', { create: true });
    projects.files.set('autosave-session-tab-b.szd', {
      data: new Uint8Array([9]),
      lastModified: Date.now(),
    });
    await expect(loadLatestAutosaveSessionRevision()).resolves.toEqual(first);
  });

  it('prefers a newer valid shared slot when a crash happens before session publication', async () => {
    const session = archive('session', '2026-07-16T00:00:00.000Z');
    const shared = archive('shared', '2026-07-16T00:01:00.000Z');
    sessionStorage.setItem(SESSION_KEY, 'tab-a');
    await saveAutosaveSessionRevision(session, '{"name":"session"}', '2026-07-16T00:00:00.000Z');
    // Mirrors the interval after useAutosave writes `autosave` but before the
    // tab's revision manifest commit finishes.
    await saveProject('autosave', shared);

    await expect(loadLatestAutosaveSessionRevision()).resolves.toEqual(shared);
  });

  it('recovers an orphaned session archive after interruption before its manifest commit', async () => {
    const published = archive('published', '2026-07-16T00:00:00.000Z');
    const interrupted = archive('interrupted', '2026-07-16T00:01:00.000Z');
    sessionStorage.setItem(SESSION_KEY, 'tab-a');
    await saveAutosaveSessionRevision(
      published,
      '{"name":"published"}',
      '2026-07-16T00:00:00.000Z',
    );
    // Mirrors a tab ending after the per-session write but before manifest publication.
    await saveProject('autosave-session-interrupted', interrupted);

    await expect(loadLatestAutosaveSessionRevision()).resolves.toEqual(interrupted);
  });

  it('keeps the latest published revision recoverable when stale-session cleanup is interrupted', async () => {
    const stale = archive('stale', '2026-07-15T00:00:00.000Z');
    const latest = archive('latest', '2026-07-16T00:01:00.000Z');
    sessionStorage.setItem(SESSION_KEY, 'tab-a');
    await saveAutosaveSessionRevision(
      archive('first'),
      '{"name":"first"}',
      '2026-07-15T00:00:00.000Z',
    );
    await saveProject('autosave-session-stale', stale);
    const projects = await root.getDirectoryHandle('projects', { create: true });
    const removeEntry = projects.removeEntry.bind(projects);
    projects.removeEntry = async (name, options) => {
      if (name === 'autosave-session-stale.szd') throw new Error('simulated cleanup interruption');
      await removeEntry(name, options);
    };
    sessionStorage.setItem(SESSION_KEY, 'tab-a');

    await expect(
      saveAutosaveSessionRevision(latest, '{"name":"latest"}', '2026-07-16T00:01:00.000Z'),
    ).rejects.toThrow('simulated cleanup interruption');
    await expect(loadLatestAutosaveSessionRevision()).resolves.toEqual(latest);
  });

  it('keeps other tabs recovery slots when the manifest is corrupt, across later saves', async () => {
    const other = archive('other', '2026-07-16T00:00:00.000Z');
    sessionStorage.setItem(SESSION_KEY, 'tab-a');
    await saveAutosaveSessionRevision(other, '{"name":"other"}', '2026-07-16T00:00:00.000Z');
    const recovery = await root.getDirectoryHandle('recovery', { create: true });
    recovery.files.set('autosave-manifest.json', {
      data: new TextEncoder().encode('{ truncated'),
      lastModified: Date.now(),
    });

    sessionStorage.setItem(SESSION_KEY, 'tab-b');
    await saveAutosaveSessionRevision(archive('b1'), '{"name":"b1"}', '2026-07-16T00:01:00.000Z');
    await saveAutosaveSessionRevision(archive('b2'), '{"name":"b2"}', '2026-07-16T00:02:00.000Z');

    expect((await listProjects()).map((entry) => entry.name)).toContain('autosave-session-tab-a');
  });

  it('gives a duplicated tab a fresh session id when another live tab holds its id', async () => {
    const held = new Set<string>();
    const request = vi.fn(
      async (name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) => {
        if (held.has(name)) return callback(null);
        held.add(name);
        return callback({ name });
      },
    );
    vi.stubGlobal('navigator', { ...navigator, locks: { request }, storage: navigator.storage });
    try {
      sessionStorage.setItem(SESSION_KEY, 'shared-id');
      // The first tab claims the id; its lock is never released while it lives.
      await saveAutosaveSessionRevision(archive('A'), '{"name":"A"}', '2026-07-16T00:00:00.000Z');
      // A duplicated tab is a fresh page: new module state, cloned sessionStorage.
      vi.resetModules();
      const duplicate = await import('@/persistence/recovery');
      sessionStorage.setItem(SESSION_KEY, 'shared-id');
      await duplicate.saveAutosaveSessionRevision(
        archive('B'),
        '{"name":"B"}',
        '2026-07-16T00:01:00.000Z',
      );

      expect(sessionStorage.getItem(SESSION_KEY)).not.toBe('shared-id');
      expect(
        (await listProjects()).filter((entry) => entry.name.startsWith('autosave-session-')),
      ).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
