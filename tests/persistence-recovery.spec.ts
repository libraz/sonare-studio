import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProjects } from '@/persistence/opfs';
import {
  loadLatestAutosaveSessionRevision,
  saveAutosaveSessionRevision,
} from '@/persistence/recovery';
import { encodeSzd } from '@/persistence/szd';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from '@/project/serialization';
import { installMockOpfs, type MemoryDirectoryHandle, uninstallMockOpfs } from './opfs-mock';

const SESSION_KEY = 'sonare-studio:autosave-session:v1';

function archive(name: string): Uint8Array {
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
  return encodeSzd(doc);
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
});
