import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
