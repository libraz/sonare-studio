import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteProject,
  InvalidProjectNameError,
  isOpfsAvailable,
  isReservedProjectName,
  listProjects,
  loadProject,
  OpfsUnavailableError,
  ProjectAlreadyExistsError,
  ProjectNotFoundError,
  renameProject,
  requestPersistentStorage,
  sanitizeProjectName,
  saveProject,
} from '@/persistence/opfs';

import { installMockOpfs, type MemoryDirectoryHandle, uninstallMockOpfs } from './opfs-mock';

/** Reads the projects/ directory of the mock root (creating it on demand). */
async function projectsDir(root: MemoryDirectoryHandle): Promise<MemoryDirectoryHandle> {
  return root.getDirectoryHandle('projects', { create: true });
}

describe('opfs project storage', () => {
  let root: MemoryDirectoryHandle;

  beforeEach(() => {
    root = installMockOpfs();
  });

  afterEach(() => {
    uninstallMockOpfs();
  });

  it('saves and loads project bytes under projects/<name>.szd', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await saveProject('My Song', bytes);
    expect((await projectsDir(root)).files.has('My Song.szd')).toBe(true);
    expect(await loadProject('My Song')).toEqual(bytes);
  });

  it('overwrites an existing project of the same name', async () => {
    await saveProject('slot', new Uint8Array([1, 2, 3]));
    await saveProject('slot', new Uint8Array([9]));
    expect(await loadProject('slot')).toEqual(new Uint8Array([9]));
  });

  it('sanitizes names consistently across save, load and list', async () => {
    await saveProject('A/B: take *2*', new Uint8Array([7]));
    expect((await projectsDir(root)).files.has('A_B_ take _2_.szd')).toBe(true);
    expect(await loadProject('A/B: take *2*')).toEqual(new Uint8Array([7]));
    const listed = await listProjects();
    expect(listed.map((p) => p.name)).toEqual(['A_B_ take _2_']);
  });

  it('does not double the extension when the name already carries .szd', async () => {
    await saveProject('demo.szd', new Uint8Array([1]));
    expect((await projectsDir(root)).files.has('demo.szd')).toBe(true);
  });

  it('rejects names that sanitize to nothing', async () => {
    await expect(saveProject('   ', new Uint8Array([1]))).rejects.toThrow(InvalidProjectNameError);
    expect(() => sanitizeProjectName('..')).toThrow(InvalidProjectNameError);
  });

  it('lists projects with size and lastModified, sorted by name', async () => {
    await saveProject('beta', new Uint8Array(10));
    await saveProject('alpha', new Uint8Array(3));
    (await projectsDir(root)).files.set('stray.txt', {
      data: new Uint8Array(1),
      lastModified: 1,
    });
    const listed = await listProjects();
    expect(listed.map((p) => p.name)).toEqual(['alpha', 'beta']);
    expect(listed[0].size).toBe(3);
    expect(listed[1].size).toBe(10);
    for (const info of listed) expect(typeof info.lastModified).toBe('number');
  });

  it('loadProject throws ProjectNotFoundError for unknown names', async () => {
    await expect(loadProject('nope')).rejects.toThrow(ProjectNotFoundError);
  });

  it('deleteProject removes the file and is idempotent', async () => {
    await saveProject('gone', new Uint8Array([1]));
    await deleteProject('gone');
    await expect(loadProject('gone')).rejects.toThrow(ProjectNotFoundError);
    await expect(deleteProject('gone')).resolves.toBeUndefined();
  });

  it('renameProject moves the bytes to the new name', async () => {
    const bytes = new Uint8Array([4, 2]);
    await saveProject('old', bytes);
    await renameProject('old', 'new');
    expect(await loadProject('new')).toEqual(bytes);
    await expect(loadProject('old')).rejects.toThrow(ProjectNotFoundError);
  });

  it('renameProject refuses to overwrite a different project', async () => {
    await saveProject('a', new Uint8Array([1]));
    await saveProject('b', new Uint8Array([2]));
    await expect(renameProject('a', 'b')).rejects.toThrow(ProjectAlreadyExistsError);
    expect(await loadProject('a')).toEqual(new Uint8Array([1]));
    expect(await loadProject('b')).toEqual(new Uint8Array([2]));
  });

  it('renameProject of a missing project throws ProjectNotFoundError', async () => {
    await expect(renameProject('ghost', 'real')).rejects.toThrow(ProjectNotFoundError);
  });

  it('renameProject to the same (sanitized) name is a no-op', async () => {
    await saveProject('same', new Uint8Array([5]));
    await renameProject('same', 'same.szd');
    expect(await loadProject('same')).toEqual(new Uint8Array([5]));
  });

  it('throws OpfsUnavailableError when navigator.storage has no getDirectory', async () => {
    uninstallMockOpfs();
    expect(isOpfsAvailable()).toBe(false);
    await expect(saveProject('x', new Uint8Array([1]))).rejects.toThrow(OpfsUnavailableError);
    await expect(loadProject('x')).rejects.toThrow(OpfsUnavailableError);
    await expect(listProjects()).rejects.toThrow(OpfsUnavailableError);
    await expect(deleteProject('x')).rejects.toThrow(OpfsUnavailableError);
    await expect(renameProject('x', 'y')).rejects.toThrow(OpfsUnavailableError);
  });

  it('isOpfsAvailable is true with the mock installed', () => {
    expect(isOpfsAvailable()).toBe(true);
  });
});

describe('sanitizeProjectName', () => {
  it('replaces unsafe characters and trims whitespace', () => {
    expect(sanitizeProjectName('  A/B: take *2*  ')).toBe('A_B_ take _2_');
    expect(sanitizeProjectName('tab\tname')).toBe('tab_name');
  });

  it('drops a trailing .szd extension case-insensitively', () => {
    expect(sanitizeProjectName('demo.SZD')).toBe('demo');
  });

  it('detects the reserved autosave slot case-insensitively after sanitizing', () => {
    expect(sanitizeProjectName('autosave')).toBe('autosave');
    expect(isReservedProjectName(' autosave.SZD ')).toBe(true);
    expect(isReservedProjectName('my autosave')).toBe(false);
  });
});

describe('requestPersistentStorage', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'storage');

  function stubStorage(storage: unknown): void {
    Object.defineProperty(navigator, 'storage', { value: storage, configurable: true });
  }

  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'storage', original);
    else Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true });
  });

  it('returns false when the Storage persist API is absent', async () => {
    stubStorage({});
    expect(await requestPersistentStorage()).toBe(false);
  });

  it('returns true without requesting when storage is already persisted', async () => {
    let persistCalls = 0;
    stubStorage({
      persisted: async () => true,
      persist: async () => {
        persistCalls += 1;
        return false;
      },
    });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persistCalls).toBe(0);
  });

  it('requests a grant and returns it when not yet persisted', async () => {
    stubStorage({ persisted: async () => false, persist: async () => true });
    expect(await requestPersistentStorage()).toBe(true);
  });

  it('still requests a grant when persisted state probing throws', async () => {
    let persistCalls = 0;
    stubStorage({
      persisted: async () => {
        throw new Error('restricted');
      },
      persist: async () => {
        persistCalls += 1;
        return true;
      },
    });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persistCalls).toBe(1);
  });

  it('returns false when persist throws', async () => {
    stubStorage({
      persisted: async () => false,
      persist: async () => {
        throw new Error('denied');
      },
    });
    expect(await requestPersistentStorage()).toBe(false);
  });
});
