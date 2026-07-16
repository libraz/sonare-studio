import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProjects } from '@/persistence/opfs';
import {
  loadLatestAutosaveSessionRevision,
  saveAutosaveSessionRevision,
} from '@/persistence/recovery';
import { installMockOpfs, type MemoryDirectoryHandle, uninstallMockOpfs } from './opfs-mock';

const SESSION_KEY = 'sonare-studio:autosave-session:v1';

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
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5, 6]);
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
