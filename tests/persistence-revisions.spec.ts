import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPersistenceMutationLockForTests } from '@/persistence/mutation-lock';
import {
  isReservedProjectName,
  listProjects,
  loadProject,
  renameProject,
  saveProject,
} from '@/persistence/opfs';
import {
  deleteProjectRevision,
  deleteProjectRevisions,
  InvalidRevisionLabelError,
  isRevisionSlot,
  listProjectRevisions,
  loadProjectRevision,
  MAX_REVISIONS_PER_PROJECT,
  sanitizeRevisionLabel,
  saveProjectRevision,
} from '@/persistence/revisions';
import { en } from '@/ui/i18n/en';
import { ja } from '@/ui/i18n/ja';
import { readSource, sourceWindow } from './helpers/source-text';
import {
  installMockOpfs,
  type MemoryDirectoryHandle,
  MemoryFileHandle,
  uninstallMockOpfs,
} from './opfs-mock';

/** Distinguishable archive bytes for a revision. */
function bytes(marker: number): Uint8Array {
  return new Uint8Array([marker, marker, marker]);
}

describe('project revisions', () => {
  let root: MemoryDirectoryHandle;
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');

  beforeEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    resetPersistenceMutationLockForTests();
    root = installMockOpfs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPersistenceMutationLockForTests();
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    uninstallMockOpfs();
  });

  it('saves labelled snapshots and reads them back newest first', async () => {
    const first = await saveProjectRevision('Song', 'before the bridge', bytes(1), 1000);
    const second = await saveProjectRevision('Song', '  extra   spaces  ', bytes(2), 2000);

    const listed = await listProjectRevisions('Song');
    expect(listed.map((entry) => entry.label)).toEqual(['extra spaces', 'before the bridge']);
    expect(listed[0].slot).toBe(second.slot);
    expect([...(await loadProjectRevision(first.slot))]).toEqual([1, 1, 1]);
    expect(listed[0].size).toBe(3);
  });

  it('picks a free slot by name without opening other stored projects', async () => {
    await saveProject('Song', bytes(7));
    const getFile = vi.spyOn(MemoryFileHandle.prototype, 'getFile');

    await saveProjectRevision('Song', 'take one', bytes(1), 1000);

    const opened = getFile.mock.contexts.map((handle) => (handle as MemoryFileHandle).name);
    expect(opened).not.toContain('Song.szd');
  });

  it('keeps revisions inside the stored-project set so media is never collected', async () => {
    const revision = await saveProjectRevision('Song', 'take 1', bytes(1), 1000);

    // The snapshot is a real stored project (the media GC scans those)...
    expect((await listProjects()).map((info) => info.name)).toContain(revision.slot);
    expect([...(await loadProject(revision.slot))]).toEqual([1, 1, 1]);
    // ...but a reserved one, so it never shows up as a project to open.
    expect(isReservedProjectName(revision.slot)).toBe(true);
    expect(isRevisionSlot(revision.slot)).toBe(true);
  });

  it('scopes listing and bulk deletion to one project', async () => {
    await saveProjectRevision('Song', 'a', bytes(1), 1000);
    await saveProjectRevision('Other', 'b', bytes(2), 1001);

    expect(await listProjectRevisions('Song')).toHaveLength(1);
    expect(await listProjectRevisions()).toHaveLength(2);

    expect(await deleteProjectRevisions('Song')).toBe(1);
    expect(await listProjectRevisions('Song')).toHaveLength(0);
    expect(await listProjectRevisions('Other')).toHaveLength(1);
  });

  it('serializes concurrent saves so neither revision index update is lost', async () => {
    const originalCreateWritable = MemoryFileHandle.prototype.createWritable;
    let releaseFirstIndexWrite!: () => void;
    let firstIndexWriteStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstIndexWriteStarted = resolve;
    });
    const firstIndexWriteGate = new Promise<void>((resolve) => {
      releaseFirstIndexWrite = resolve;
    });
    let indexWrites = 0;
    vi.spyOn(MemoryFileHandle.prototype, 'createWritable').mockImplementation(async function (
      this: MemoryFileHandle,
    ) {
      const writable = await originalCreateWritable.call(this);
      if (this.name === 'index.json' && indexWrites++ === 0) {
        firstIndexWriteStarted();
        await firstIndexWriteGate;
      }
      return writable;
    });

    const first = saveProjectRevision('Song', 'first', bytes(1), 1000);
    await firstStarted;
    const second = saveProjectRevision('Song', 'second', bytes(2), 1000);
    await Promise.resolve();
    releaseFirstIndexWrite();
    await Promise.all([first, second]);

    const listed = await listProjectRevisions('Song');
    expect(listed).toHaveLength(2);
    expect(listed.map((entry) => entry.label).sort()).toEqual(['first', 'second']);
    expect(new Set(listed.map((entry) => entry.slot)).size).toBe(2);
  });

  it('serializes concurrent deletes so neither revision slot is left behind', async () => {
    const first = await saveProjectRevision('Song', 'first', bytes(1), 1000);
    const second = await saveProjectRevision('Song', 'second', bytes(2), 2000);
    const originalCreateWritable = MemoryFileHandle.prototype.createWritable;
    let releaseFirstIndexWrite!: () => void;
    let firstIndexWriteStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstIndexWriteStarted = resolve;
    });
    const firstIndexWriteGate = new Promise<void>((resolve) => {
      releaseFirstIndexWrite = resolve;
    });
    let indexWrites = 0;
    vi.spyOn(MemoryFileHandle.prototype, 'createWritable').mockImplementation(async function (
      this: MemoryFileHandle,
    ) {
      const writable = await originalCreateWritable.call(this);
      if (this.name === 'index.json' && indexWrites++ === 0) {
        firstIndexWriteStarted();
        await firstIndexWriteGate;
      }
      return writable;
    });

    const removeFirst = deleteProjectRevision(first.slot);
    await firstStarted;
    const removeSecond = deleteProjectRevision(second.slot);
    await Promise.resolve();
    releaseFirstIndexWrite();
    await Promise.all([removeFirst, removeSecond]);

    expect(await listProjectRevisions('Song')).toEqual([]);
    expect((await listProjects()).filter((info) => isRevisionSlot(info.name))).toEqual([]);
  });

  it('serializes a deletion with a concurrent save without leaving an unindexed slot', async () => {
    const old = await saveProjectRevision('Song', 'old', bytes(1), 1000);
    const originalCreateWritable = MemoryFileHandle.prototype.createWritable;
    let releaseDeleteIndexWrite!: () => void;
    let deleteIndexWriteStarted!: () => void;
    const deleteIndexWrite = new Promise<void>((resolve) => {
      deleteIndexWriteStarted = resolve;
    });
    const deleteIndexWriteGate = new Promise<void>((resolve) => {
      releaseDeleteIndexWrite = resolve;
    });
    let indexWrites = 0;
    vi.spyOn(MemoryFileHandle.prototype, 'createWritable').mockImplementation(async function (
      this: MemoryFileHandle,
    ) {
      const writable = await originalCreateWritable.call(this);
      if (this.name === 'index.json' && indexWrites++ === 0) {
        deleteIndexWriteStarted();
        await deleteIndexWriteGate;
      }
      return writable;
    });

    const deleting = deleteProjectRevision(old.slot);
    await deleteIndexWrite;
    const saving = saveProjectRevision('Song', 'new', bytes(2), 2000);
    await Promise.resolve();
    releaseDeleteIndexWrite();
    const [, saved] = await Promise.all([deleting, saving]);

    expect(await listProjectRevisions('Song')).toMatchObject([{ slot: saved.slot, label: 'new' }]);
    expect(
      (await listProjects()).filter((info) => isRevisionSlot(info.name)).map((info) => info.name),
    ).toEqual([saved.slot]);
  });

  it('removes a newly written slot when revision index publication fails', async () => {
    const originalCreateWritable = MemoryFileHandle.prototype.createWritable;
    const writableSpy = vi
      .spyOn(MemoryFileHandle.prototype, 'createWritable')
      .mockImplementation(async function (this: MemoryFileHandle) {
        if (this.name === 'index.json') throw new Error('revision index write failed');
        return originalCreateWritable.call(this);
      });

    await expect(saveProjectRevision('Song', 'failed', bytes(7), 1000)).rejects.toThrow(
      'revision index write failed',
    );
    writableSpy.mockRestore();

    expect(await listProjectRevisions('Song')).toEqual([]);
    expect((await listProjects()).filter((info) => isRevisionSlot(info.name))).toEqual([]);
  });

  it('keeps an unindexed slot left between payload and index publication', async () => {
    const kept = await saveProjectRevision('Song', 'kept history', bytes(1), 1000);

    // A slot the index does not name may be the only copy of a lost history.
    await saveProject('revision-interrupted', bytes(9));

    const next = await saveProjectRevision('Song', 'new history', bytes(2), 2000);

    expect(await listProjectRevisions('Song')).toMatchObject([
      { slot: next.slot, label: 'new history' },
      { slot: kept.slot, label: 'kept history' },
    ]);
    expect((await listProjects()).map((info) => info.name)).toContain('revision-interrupted');
  });

  it('never deletes revision slots after the index is lost, however many saves follow', async () => {
    const first = await saveProjectRevision('Song', 'a', bytes(1), 1000);
    const directory = await root.getDirectoryHandle('revisions', { create: true });
    await directory.removeEntry('index.json');

    await saveProjectRevision('Song', 'b', bytes(2), 2000);
    await saveProjectRevision('Song', 'c', bytes(3), 3000);

    expect((await listProjects()).map((info) => info.name)).toContain(first.slot);
    expect([...(await loadProjectRevision(first.slot))]).toEqual([1, 1, 1]);
  });

  it('renames revision ownership with the project and deletes it under the new name', async () => {
    await saveProject('Song', bytes(9));
    const revision = await saveProjectRevision('Song', 'before rename', bytes(1), 1000);

    await renameProject('Song', 'Renamed Song');

    expect(await listProjectRevisions('Song')).toHaveLength(0);
    expect(await listProjectRevisions('Renamed Song')).toMatchObject([
      { slot: revision.slot, projectName: 'Renamed Song' },
    ]);
    expect(await deleteProjectRevisions('Renamed Song')).toBe(1);
    expect((await listProjects()).filter((info) => isRevisionSlot(info.name))).toHaveLength(0);
  });

  it('keeps the old project and revision index when rename publication fails', async () => {
    await saveProject('Song', bytes(9));
    const revision = await saveProjectRevision('Song', 'before failure', bytes(1), 1000);
    const originalCreateWritable = MemoryFileHandle.prototype.createWritable;
    const writableSpy = vi
      .spyOn(MemoryFileHandle.prototype, 'createWritable')
      .mockImplementation(async function (this: MemoryFileHandle) {
        if (this.name === 'index.json') throw new Error('revision index write failed');
        return originalCreateWritable.call(this);
      });

    await expect(renameProject('Song', 'Renamed Song')).rejects.toThrow(
      'revision index write failed',
    );
    writableSpy.mockRestore();

    expect(await loadProject('Song')).toEqual(bytes(9));
    expect((await listProjects()).map((info) => info.name)).not.toContain('Renamed Song');
    expect(await listProjectRevisions('Song')).toMatchObject([{ slot: revision.slot }]);
    expect(await listProjectRevisions('Renamed Song')).toHaveLength(0);
  });

  it('deletes one revision with its stored slot', async () => {
    const revision = await saveProjectRevision('Song', 'a', bytes(1), 1000);

    await deleteProjectRevision(revision.slot);

    expect(await listProjectRevisions('Song')).toHaveLength(0);
    expect((await listProjects()).map((info) => info.name)).not.toContain(revision.slot);
    // Deleting an unknown slot is a no-op, not a failure.
    await expect(deleteProjectRevision('revision-missing')).resolves.toBeUndefined();
  });

  it('prunes the oldest generations past the per-project cap', async () => {
    for (let index = 0; index <= MAX_REVISIONS_PER_PROJECT; index += 1) {
      await saveProjectRevision('Song', `take ${index}`, bytes(index), 1000 + index);
    }

    const listed = await listProjectRevisions('Song');
    expect(listed).toHaveLength(MAX_REVISIONS_PER_PROJECT);
    expect(listed.map((entry) => entry.label)).not.toContain('take 0');
    // The pruned slot's bytes are gone too, so storage does not grow forever.
    expect((await listProjects()).filter((info) => isRevisionSlot(info.name))).toHaveLength(
      MAX_REVISIONS_PER_PROJECT,
    );
  });

  it('never reuses a slot that already exists', async () => {
    const first = await saveProjectRevision('Song', 'a', bytes(1), 1000);
    const second = await saveProjectRevision('Song', 'b', bytes(2), 1000);

    expect(second.slot).not.toBe(first.slot);
    expect([...(await loadProjectRevision(first.slot))]).toEqual([1, 1, 1]);
    expect([...(await loadProjectRevision(second.slot))]).toEqual([2, 2, 2]);
  });

  it('rejects empty labels and bounds long ones', () => {
    expect(() => sanitizeRevisionLabel('   ')).toThrow(InvalidRevisionLabelError);
    expect(sanitizeRevisionLabel('x'.repeat(200))).toHaveLength(60);
  });

  it('ignores a corrupt index instead of hiding the feature', async () => {
    await saveProjectRevision('Song', 'a', bytes(1), 1000);
    const directory = await root.getDirectoryHandle('revisions', { create: true });
    const handle = await directory.getFileHandle('index.json', { create: true });
    const writable = await handle.createWritable();
    await writable.write(new TextEncoder().encode('{ not json'));
    await writable.close();

    expect(await listProjectRevisions('Song')).toEqual([]);
    // A later save rebuilds a valid index.
    const revision = await saveProjectRevision('Song', 'b', bytes(2), 2000);
    expect(await listProjectRevisions('Song')).toMatchObject([{ slot: revision.slot }]);
  });

  it('drops malformed index records but keeps valid ones', async () => {
    await saveProject('revision-manual', bytes(9));
    const directory = await root.getDirectoryHandle('revisions', { create: true });
    const handle = await directory.getFileHandle('index.json', { create: true });
    const writable = await handle.createWritable();
    await writable.write(
      new TextEncoder().encode(
        JSON.stringify([
          { slot: 'revision-manual', projectName: 'Song', label: 'kept', savedAt: 5, size: 3 },
          { slot: 'not-a-revision', projectName: 'Song', label: 'bad', savedAt: 6 },
          { slot: 'revision-x', projectName: 'Song', savedAt: 7 },
          'nonsense',
        ]),
      ),
    );
    await writable.close();

    expect(await listProjectRevisions('Song')).toMatchObject([{ label: 'kept' }]);
  });
});

describe('revision entry points', () => {
  const persistence = readSource('src/composables/useProjectPersistence.ts');

  it('snapshots the live document under a prompted label', () => {
    expect(persistence).toContain('await saveProjectRevision(');
    expect(persistence).toContain('savedProjectSlot.value ?? store.projectName');
  });

  it('restores into the editor without overwriting the stored project', () => {
    expect(persistence).toContain('const bytes = await loadProjectRevision(slot);');
    const restore = sourceWindow(
      persistence,
      'function restoreRevision',
      'function deleteRevision',
    );
    // The Save baseline stays the revision this tab last loaded or saved.
    expect(restore).not.toMatch(/savedProjectRevision\.value =|loadProjectWithRevision\(/);
  });

  it('drops a project’s revisions with the project itself', () => {
    expect(persistence).toContain('await deleteProjectRevisions(name);');
  });

  it('labels the dialog in every locale', () => {
    for (const bundle of [en, ja]) {
      expect(bundle.dialogs.revisions.title.length).toBeGreaterThan(0);
      expect(bundle.dialogs.revisions.note.length).toBeGreaterThan(0);
      expect(bundle.dialogs.revisions.empty.length).toBeGreaterThan(0);
      expect(bundle.dialogs.revisions.saveCurrent.length).toBeGreaterThan(0);
      expect(bundle.shell.project.revisions.length).toBeGreaterThan(0);
      expect(bundle.dialogs.prompts.saveRevisionTitle.length).toBeGreaterThan(0);
    }
  });
});
