import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isReservedProjectName, listProjects, loadProject, saveProject } from '@/persistence/opfs';
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
import { installMockOpfs, type MemoryDirectoryHandle, uninstallMockOpfs } from './opfs-mock';

/** Distinguishable archive bytes for a revision. */
function bytes(marker: number): Uint8Array {
  return new Uint8Array([marker, marker, marker]);
}

describe('project revisions', () => {
  let root: MemoryDirectoryHandle;

  beforeEach(() => {
    root = installMockOpfs();
  });

  afterEach(() => {
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
  const persistence = readFileSync(
    resolve(process.cwd(), 'src/composables/useProjectPersistence.ts'),
    'utf8',
  );

  it('snapshots the live document under a prompted label', () => {
    expect(persistence).toContain('await saveProjectRevision(');
    expect(persistence).toContain('savedProjectSlot.value ?? store.projectName');
  });

  it('restores into the editor without overwriting the stored project', () => {
    expect(persistence).toContain('const bytes = await loadProjectRevision(slot);');
    expect(persistence).toContain('savedProjectRevision.value = null;');
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
