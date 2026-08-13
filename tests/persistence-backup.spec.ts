import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAudioAssetCache, loadAsset, loadAssetMeta, saveAsset } from '@/persistence/assets';
import {
  BrowserBackupSizeError,
  createBrowserBackup,
  createBrowserBackupWithReport,
  reclaimOrphanedRestoreStages,
  reclaimOrphanedRestoreStagesAtStartup,
  restoreBrowserBackup,
  setBrowserBackupRestoreFaultInjectorForTests,
} from '@/persistence/backup';
import { loadProject, saveProject } from '@/persistence/opfs';
import {
  listProjectRevisions,
  loadProjectRevision,
  saveProjectRevision,
} from '@/persistence/revisions';
import { encodeSzd } from '@/persistence/szd';
import {
  clearFontCache,
  getFontCacheStats,
  loadFont,
  loadFontMeta,
  saveFont,
} from '@/project/fonts';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from '@/project/serialization';
import { installMockOpfs, MemoryFileHandle, uninstallMockOpfs } from './opfs-mock';

function makeDocument(
  name: string,
  refs: { assetId?: string; fontId?: string } = {},
): ProjectDocument {
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name,
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks:
      refs.assetId || refs.fontId
        ? [
            {
              name: 'Media',
              color: '#60a5fa',
              kind: 'audio',
              mute: false,
              solo: false,
              volume: 1,
              pan: 0,
              ...(refs.fontId ? { instrument: { kind: 'sf2' as const, fontId: refs.fontId } } : {}),
              clips: refs.assetId
                ? [
                    {
                      name: 'Audio',
                      startPpq: 0,
                      lengthPpq: 4,
                      sourceOffsetPpq: 0,
                      gain: 1,
                      notes: [],
                      assetId: refs.assetId,
                    },
                  ]
                : [],
            },
          ]
        : [],
    markers: [],
    sections: [],
  };
}

function stereo(): Float32Array[] {
  return [new Float32Array([0.1, 0.2]), new Float32Array([-0.1, -0.2])];
}

/** A minimal RIFF/sfbk prefix; payload contents are irrelevant to OPFS tests. */
function sf2(...payload: number[]): Uint8Array {
  return new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x73, 0x66, 0x62, 0x6b, ...payload]);
}

describe('browser backup archives', () => {
  beforeEach(() => {
    installMockOpfs();
    clearAudioAssetCache();
    clearFontCache();
  });

  afterEach(() => {
    setBrowserBackupRestoreFaultInjectorForTests(null);
    uninstallMockOpfs();
    clearAudioAssetCache();
    clearFontCache();
  });

  it('backs up and restores all projects, shared audio assets, and SoundFonts', async () => {
    const projectBytes = encodeSzd(makeDocument('Song A', { assetId: 'assetA', fontId: 'fontA' }));
    await saveProject('Song A', projectBytes);
    await saveAsset(
      { id: 'assetA', name: 'Shared audio', sampleRate: 48000, tags: { bpm: 124 } },
      stereo(),
    );
    await saveFont({ id: 'fontA', name: 'Shared font' }, sf2(1, 2, 3, 4));
    await saveAsset({ id: 'libraryOnly', name: 'Library only audio', sampleRate: 48000 }, stereo());
    await saveFont({ id: 'libraryOnlyFont', name: 'Library only font' }, sf2(9, 8, 7));

    const backup = await createBrowserBackup('2026-07-04T00:00:00.000Z');
    const entries = unzipSync(backup);
    const manifest = JSON.parse(new TextDecoder().decode(entries['meta.json'])) as {
      version: number;
      inventory: {
        complete: boolean;
        totalBytes: number;
        projects: unknown[];
        assets: unknown[];
        fonts: unknown[];
      };
    };
    expect(manifest).toMatchObject({
      version: 2,
      inventory: { complete: true },
    });
    expect(manifest.inventory.projects).toHaveLength(1);
    expect(manifest.inventory.assets).toHaveLength(2);
    expect(manifest.inventory.fonts).toHaveLength(2);
    expect(manifest.inventory.totalBytes).toBeGreaterThan(0);

    uninstallMockOpfs();
    installMockOpfs();
    clearAudioAssetCache();
    clearFontCache();

    const restored = await restoreBrowserBackup(backup);

    expect(restored).toEqual({ projects: 1, assets: 2, fonts: 2 });
    expect(await loadProject('Song A')).toEqual(projectBytes);
    expect((await loadAsset('assetA')).channels).toEqual(stereo());
    expect((await loadAssetMeta('assetA')).tags).toEqual({ bpm: 124 });
    expect(await loadFont('fontA')).toEqual(sf2(1, 2, 3, 4));
    expect((await loadFontMeta('fontA')).name).toBe('Shared font');
    expect((await loadAssetMeta('libraryOnly')).name).toBe('Library only audio');
    expect(await loadFont('libraryOnlyFont')).toEqual(sf2(9, 8, 7));
  });

  it('backs up and restores named revision history while excluding autosave slots', async () => {
    const projectBytes = encodeSzd(makeDocument('Song A'));
    const firstRevisionBytes = encodeSzd(makeDocument('Song A', { assetId: 'unused-a' }));
    const secondRevisionBytes = encodeSzd(makeDocument('Song A', { assetId: 'unused-b' }));
    await saveProject('Song A', projectBytes);
    const first = await saveProjectRevision('Song A', 'before bridge', firstRevisionBytes, 1000);
    const second = await saveProjectRevision('Song A', 'after bridge', secondRevisionBytes, 2000);
    await saveProject('autosave', encodeSzd(makeDocument('Autosave')));
    await saveProject('autosave-session-backup-tab', encodeSzd(makeDocument('Recovery')));

    const entries = unzipSync(await createBrowserBackup('2026-07-04T00:00:00.000Z'));
    expect(entries['revisions/index.json']).toBeDefined();
    expect(entries[`revisions/${first.slot}.szd`]).toEqual(firstRevisionBytes);
    expect(entries[`revisions/${second.slot}.szd`]).toEqual(secondRevisionBytes);
    expect(entries['projects/autosave.szd']).toBeUndefined();
    expect(entries['projects/autosave-session-backup-tab.szd']).toBeUndefined();

    uninstallMockOpfs();
    installMockOpfs();
    await restoreBrowserBackup(zipSync(entries));

    expect(await listProjectRevisions('Song A')).toEqual([second, first]);
    expect(await loadProjectRevision(first.slot)).toEqual(firstRevisionBytes);
    expect(await loadProjectRevision(second.slot)).toEqual(secondRevisionBytes);
    await expect(loadProject('autosave')).rejects.toThrow();
    await expect(loadProject('autosave-session-backup-tab')).rejects.toThrow();
  });

  it('normalizes a legacy revision size while backing up its stored slot', async () => {
    const legacySlot = 'revision-legacy-size';
    const revisionBytes = encodeSzd(makeDocument('Legacy Song'));
    await saveProject(legacySlot, revisionBytes);
    const root = await navigator.storage.getDirectory();
    const revisions = await root.getDirectoryHandle('revisions', { create: true });
    const index = await revisions.getFileHandle('index.json', { create: true });
    const writable = await index.createWritable();
    await writable.write(
      new TextEncoder().encode(
        JSON.stringify([
          {
            slot: legacySlot,
            projectName: 'Legacy Song',
            label: 'legacy checkpoint',
            savedAt: 1000,
          },
        ]),
      ),
    );
    await writable.close();

    const backup = await createBrowserBackup('2026-08-13T00:00:00.000Z');
    const entries = unzipSync(backup);
    expect(JSON.parse(new TextDecoder().decode(entries['revisions/index.json']))).toEqual([
      {
        slot: legacySlot,
        projectName: 'Legacy Song',
        label: 'legacy checkpoint',
        savedAt: 1000,
        size: revisionBytes.byteLength,
      },
    ]);

    uninstallMockOpfs();
    installMockOpfs();

    await restoreBrowserBackup(backup);

    expect(await listProjectRevisions('Legacy Song')).toEqual([
      expect.objectContaining({ slot: legacySlot, size: revisionBytes.byteLength }),
    ]);
    expect(await loadProjectRevision(legacySlot)).toEqual(revisionBytes);
  });

  it('adds archived revision history without dropping unrelated local history', async () => {
    const archivedBytes = encodeSzd(makeDocument('Archived Song'));
    await saveProject('Archived Song', archivedBytes);
    const archived = await saveProjectRevision(
      'Archived Song',
      'archive checkpoint',
      archivedBytes,
      1000,
    );
    const backup = await createBrowserBackup('2026-07-04T00:00:00.000Z');

    uninstallMockOpfs();
    installMockOpfs();
    const localBytes = encodeSzd(makeDocument('Local Song'));
    await saveProject('Local Song', localBytes);
    const local = await saveProjectRevision('Local Song', 'local checkpoint', localBytes, 2000);

    await restoreBrowserBackup(backup);

    expect(await listProjectRevisions('Archived Song')).toEqual([archived]);
    expect(await listProjectRevisions('Local Song')).toEqual([local]);
    expect(await loadProjectRevision(archived.slot)).toEqual(archivedBytes);
    expect(await loadProjectRevision(local.slot)).toEqual(localBytes);
  });

  it('rejects a conflicting revision slot instead of overwriting local history', async () => {
    const archivedBytes = encodeSzd(makeDocument('Archived Song'));
    await saveProject('Archived Song', archivedBytes);
    const archived = await saveProjectRevision(
      'Archived Song',
      'archive checkpoint',
      archivedBytes,
      1000,
    );
    const backup = await createBrowserBackup('2026-07-04T00:00:00.000Z');

    uninstallMockOpfs();
    installMockOpfs();
    const localBytes = encodeSzd(makeDocument('Local Song', { assetId: 'local-only' }));
    await saveProject('Local Song', localBytes);
    const local = await saveProjectRevision('Local Song', 'local checkpoint', localBytes, 1000);
    expect(local.slot).toBe(archived.slot);

    await expect(restoreBrowserBackup(backup)).rejects.toThrow('revision slot conflicts');

    expect(await listProjectRevisions('Local Song')).toEqual([local]);
    expect(await loadProjectRevision(local.slot)).toEqual(localBytes);
    await expect(loadProject('Archived Song')).rejects.toThrow();
  });

  it('accepts a stale revision index when an older slot payload is missing', async () => {
    await saveProject('Song A', encodeSzd(makeDocument('Song A')));
    const revision = await saveProjectRevision(
      'Song A',
      'old payload',
      encodeSzd(makeDocument('Song A')),
      1000,
    );
    const root = await navigator.storage.getDirectory();
    const projects = await root.getDirectoryHandle('projects');
    await projects.removeEntry(`${revision.slot}.szd`);

    const backup = await createBrowserBackup('2026-07-04T00:00:00.000Z');
    const entries = unzipSync(backup);
    expect(entries[`revisions/${revision.slot}.szd`]).toBeUndefined();

    uninstallMockOpfs();
    installMockOpfs();
    await restoreBrowserBackup(backup);

    expect(await listProjectRevisions('Song A')).toEqual([revision]);
    await expect(loadProjectRevision(revision.slot)).rejects.toThrow();
  });

  it('rolls back revision slots and index when revision-index publication fails', async () => {
    const previousProject = encodeSzd(makeDocument('Song A'));
    const previousRevisionBytes = encodeSzd(makeDocument('Song A'));
    await saveProject('Song A', previousProject);
    const previous = await saveProjectRevision('Song A', 'old', previousRevisionBytes, 1000);

    const replacementProject = encodeSzd(makeDocument('Song A'));
    const replacementRevisionBytes = encodeSzd(makeDocument('Song A'));
    await saveProject('Song A', replacementProject);
    await saveProjectRevision('Song A', 'new', replacementRevisionBytes, 2000);
    const backup = await createBrowserBackup('2026-07-04T00:00:00.000Z');

    uninstallMockOpfs();
    installMockOpfs();
    await saveProject('Song A', previousProject);
    await saveProjectRevision('Song A', 'old', previousRevisionBytes, 1000);

    const originalCreateWritable = MemoryFileHandle.prototype.createWritable;
    let failOnce = true;
    vi.spyOn(MemoryFileHandle.prototype, 'createWritable').mockImplementation(async function (
      this: MemoryFileHandle,
    ) {
      if (this.name === 'index.json' && failOnce) {
        failOnce = false;
        throw new Error('revision index publication failed');
      }
      return originalCreateWritable.call(this);
    });

    await expect(restoreBrowserBackup(backup)).rejects.toThrow('revision index publication failed');

    expect(await listProjectRevisions('Song A')).toMatchObject([previous]);
    expect(await loadProjectRevision(previous.slot)).toEqual(previousRevisionBytes);
    expect(await loadProject('Song A')).toEqual(previousProject);
  });

  it('does not retain every SoundFont in the playback cache while backing up', async () => {
    await saveFont({ id: 'fontOne', name: 'One' }, sf2(...new Array(52).fill(1)));
    await saveFont({ id: 'fontTwo', name: 'Two' }, sf2(...new Array(52).fill(2)));
    clearFontCache();

    await createBrowserBackup('2026-07-04T00:00:00.000Z');

    expect(getFontCacheStats()).toMatchObject({ entries: 0, byteLength: 0 });
  });

  it('reports every missing project media role before creating a lossy backup', async () => {
    const document = makeDocument('Missing', { assetId: 'missingClip', fontId: 'missingFont' });
    document.tracks[0].frozen = { assetId: 'missingFrozen' };
    document.tracks[0].clips[0].takes = [{ assetId: 'missingTake', name: 'Take' }];
    await saveProject('Missing', encodeSzd(document));

    const backup = await createBrowserBackupWithReport('2026-07-04T00:00:00.000Z');

    expect(backup.completeness.complete).toBe(false);
    expect(
      backup.completeness.issues.map((issue) => [
        issue.mediaId,
        issue.role,
        issue.trackId,
        issue.clipId,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['missingClip', 'clip', 1, 1],
        ['missingTake', 'take', 1, 1],
        ['missingFrozen', 'frozen', 1, undefined],
        ['missingFont', 'instrument', 1, undefined],
      ]),
    );
    const manifest = JSON.parse(new TextDecoder().decode(unzipSync(backup.bytes)['meta.json'])) as {
      inventory: { complete: boolean };
    };
    expect(manifest.inventory.complete).toBe(false);
  });

  it('rejects backup output that would exceed the matching restore ceiling', async () => {
    await saveProject('A', encodeSzd(makeDocument('A')));

    await expect(
      createBrowserBackupWithReport('2026-07-04T00:00:00.000Z', undefined, {
        maxCompressedBytes: 1024,
        maxEntries: 100,
        maxEntryBytes: 1,
        maxOuterExpandedBytes: 1024,
        maxTotalExpandedBytes: 2048,
      }),
    ).rejects.toBeInstanceOf(BrowserBackupSizeError);
  });

  it('rejects a v2 backup whose inventory checksum no longer matches its payload', async () => {
    await saveProject('Song A', encodeSzd(makeDocument('Song A', { assetId: 'assetA' })));
    await saveAsset({ id: 'assetA', name: 'Audio', sampleRate: 48000 }, stereo());
    const entries = unzipSync(await createBrowserBackup('2026-07-04T00:00:00.000Z'));
    entries['assets/assetA.pcm'] = entries['assets/assetA.pcm'].slice();
    entries['assets/assetA.pcm'][0] ^= 0xff;

    await expect(restoreBrowserBackup(zipSync(entries))).rejects.toThrow(
      'Invalid sonare browser backup.',
    );
  });

  it('leaves the active browser autosave and session recovery slots local', async () => {
    const named = encodeSzd(makeDocument('Named'));
    await saveProject('Named', named);
    await saveProject('autosave', encodeSzd(makeDocument('Backup autosave')));
    await saveProject(
      'autosave-session-backup-tab',
      encodeSzd(makeDocument('Backup session autosave')),
    );
    const backup = await createBrowserBackup('2026-07-04T00:00:00.000Z');

    uninstallMockOpfs();
    installMockOpfs();
    const currentAutosave = encodeSzd(makeDocument('Current autosave'));
    const currentSession = encodeSzd(makeDocument('Current session autosave'));
    await saveProject('autosave', currentAutosave);
    await saveProject('autosave-session-current-tab', currentSession);

    await expect(restoreBrowserBackup(backup)).resolves.toEqual({
      projects: 1,
      assets: 0,
      fonts: 0,
    });
    expect(await loadProject('Named')).toEqual(named);
    expect(await loadProject('autosave')).toEqual(currentAutosave);
    expect(await loadProject('autosave-session-current-tab')).toEqual(currentSession);
    await expect(loadProject('autosave-session-backup-tab')).rejects.toThrow();
  });

  it('rejects archives without sonare browser-backup metadata', async () => {
    await expect(restoreBrowserBackup(encodeSzd(makeDocument('Not a backup')))).rejects.toThrow(
      'Invalid sonare browser backup.',
    );
  });

  it('skips malformed media entries while restoring the rest of the backup', async () => {
    const projectBytes = encodeSzd(makeDocument('Song A', { assetId: 'good', fontId: 'goodFont' }));
    const validPcm = new Uint8Array(stereo()[0].buffer).slice();
    const backup = zipSync({
      'meta.json': strToU8(
        JSON.stringify({
          app: 'sonare-studio',
          kind: 'browser-backup',
          version: 1,
          savedAt: '2026-07-04T00:00:00.000Z',
          projects: 1,
          assets: 1,
          fonts: 1,
        }),
      ),
      'projects/Song%20A.szd': projectBytes,
      'assets/good.json': strToU8(
        JSON.stringify({
          id: 'good',
          name: 'Good audio',
          sampleRate: 48000,
          numChannels: 1,
          numFrames: validPcm.byteLength / 4,
        }),
      ),
      'assets/good.pcm': validPcm,
      'assets/bad-meta.json': strToU8(JSON.stringify({ name: '', sampleRate: 48000 })),
      'assets/bad-meta.pcm': validPcm,
      'assets/bad-pcm.json': strToU8(
        JSON.stringify({ name: 'Bad PCM', sampleRate: 48000, numChannels: 1 }),
      ),
      'assets/bad-pcm.pcm': new Uint8Array([1, 2, 3]),
      'fonts/goodFont.json': strToU8(
        JSON.stringify({ id: 'goodFont', name: 'Good font', byteLength: sf2(1, 2, 3).byteLength }),
      ),
      'fonts/goodFont.sf2': sf2(1, 2, 3),
      'fonts/badFont.json': strToU8(JSON.stringify({ name: '' })),
      'fonts/badFont.sf2': new Uint8Array([4, 5, 6]),
    });

    const restored = await restoreBrowserBackup(backup);

    expect(restored).toEqual({
      projects: 1,
      assets: 1,
      fonts: 1,
      skippedAssetIds: ['bad-meta', 'bad-pcm'],
      skippedFontIds: ['badFont'],
    });
    expect(await loadProject('Song A')).toEqual(projectBytes);
    expect((await loadAssetMeta('good')).name).toBe('Good audio');
    expect(await loadFont('goodFont')).toEqual(sf2(1, 2, 3));
    await expect(loadAsset('bad-meta')).rejects.toThrow();
    await expect(loadAsset('bad-pcm')).rejects.toThrow();
    await expect(loadFont('badFont')).rejects.toThrow();
  });

  it('rejects media id conflicts before overwriting projects or shared content', async () => {
    const existingProject = encodeSzd(makeDocument('Existing'));
    await saveProject('Song A', existingProject);
    await saveAsset({ id: 'assetA', name: 'Existing audio', sampleRate: 48000 }, [
      new Float32Array([0.9]),
    ]);
    const incomingAudio = new Float32Array([0.1]);
    const incomingProject = encodeSzd(makeDocument('Song A', { assetId: 'assetA' }));
    const backup = zipSync({
      'meta.json': strToU8(
        JSON.stringify({
          app: 'sonare-studio',
          kind: 'browser-backup',
          version: 1,
          savedAt: '2026-07-15T00:00:00.000Z',
          projects: 1,
          assets: 1,
          fonts: 0,
        }),
      ),
      'projects/Song%20A.szd': incomingProject,
      'assets/assetA.json': strToU8(
        JSON.stringify({
          id: 'assetA',
          name: 'Incoming audio',
          sampleRate: 48000,
          numChannels: 1,
          numFrames: 1,
        }),
      ),
      'assets/assetA.pcm': new Uint8Array(incomingAudio.buffer).slice(),
    });

    await expect(restoreBrowserBackup(backup)).rejects.toThrow('conflicts');
    expect(await loadProject('Song A')).toEqual(existingProject);
    expect((await loadAsset('assetA')).channels[0]).toEqual(new Float32Array([0.9]));
  });

  it('rejects project names that collide after filesystem sanitization', async () => {
    const backup = zipSync({
      'meta.json': strToU8(
        JSON.stringify({
          app: 'sonare-studio',
          kind: 'browser-backup',
          version: 1,
          savedAt: '2026-07-15T00:00:00.000Z',
          projects: 2,
          assets: 0,
          fonts: 0,
        }),
      ),
      'projects/A%3AB.szd': encodeSzd(makeDocument('A:B')),
      'projects/A%3FB.szd': encodeSzd(makeDocument('A?B')),
    });

    await expect(restoreBrowserBackup(backup)).rejects.toThrow('colliding project name');
    await expect(loadProject('A_B')).rejects.toThrow();
  });

  it('rolls back newly restored media when a project write runs out of quota', async () => {
    const root = installMockOpfs();
    clearAudioAssetCache();
    const projectDir = await root.getDirectoryHandle('projects', { create: true });
    const originalGetFileHandle = projectDir.getFileHandle.bind(projectDir);
    let failOnce = true;
    vi.spyOn(projectDir, 'getFileHandle').mockImplementation(async (name, options) => {
      const handle = await originalGetFileHandle(name, options);
      if (name !== 'Song A.szd' || !failOnce) return handle;
      return {
        ...handle,
        createWritable: async () =>
          ({
            write: async () => {
              failOnce = false;
              const error = new Error('quota');
              error.name = 'QuotaExceededError';
              throw error;
            },
            close: async () => {},
          }) as unknown as FileSystemWritableFileStream,
      } as unknown as typeof handle;
    });

    const audio = new Float32Array([0.1]);
    const backup = zipSync({
      'meta.json': strToU8(
        JSON.stringify({
          app: 'sonare-studio',
          kind: 'browser-backup',
          version: 1,
          savedAt: '2026-07-15T00:00:00.000Z',
          projects: 1,
          assets: 1,
          fonts: 0,
        }),
      ),
      'projects/Song%20A.szd': encodeSzd(makeDocument('Song A', { assetId: 'newAsset' })),
      'assets/newAsset.json': strToU8(
        JSON.stringify({
          id: 'newAsset',
          name: 'New audio',
          sampleRate: 48000,
          numChannels: 1,
          numFrames: 1,
        }),
      ),
      'assets/newAsset.pcm': new Uint8Array(audio.buffer).slice(),
    });

    await expect(restoreBrowserBackup(backup)).rejects.toThrow('Project storage is full');
    await expect(loadProject('Song A')).rejects.toThrow();
    await expect(loadAsset('newAsset')).rejects.toThrow();
  });

  /** Seeds an orphaned restore-staging namespace as a crashed restore would leave. */
  async function seedOrphanStage(transactionId: string): Promise<void> {
    const root = await navigator.storage.getDirectory();
    const staging = await root.getDirectoryHandle('restore-staging', { create: true });
    const stage = await staging.getDirectoryHandle(transactionId, { create: true });
    const handle = await stage.getFileHandle('manifest.json', { create: true });
    const writable = await handle.createWritable();
    await writable.write(new TextEncoder().encode('{"state":"prepared"}'));
    await writable.close();
  }

  it('reclaims staging namespaces orphaned by a crashed restore', async () => {
    await seedOrphanStage('dead-txn-1');
    await seedOrphanStage('dead-txn-2');
    await seedOrphanStage('dead-txn-3');

    expect(await reclaimOrphanedRestoreStages()).toBe(3);

    const root = await navigator.storage.getDirectory();
    const staging = await root.getDirectoryHandle('restore-staging');
    await expect(staging.getDirectoryHandle('dead-txn-1')).rejects.toThrow();
    await expect(staging.getDirectoryHandle('dead-txn-2')).rejects.toThrow();
    await expect(staging.getDirectoryHandle('dead-txn-3')).rejects.toThrow();

    // A second sweep with nothing left is a no-op.
    expect(await reclaimOrphanedRestoreStages()).toBe(0);
  });

  it('rolls an interrupted project publish back from its durable pre-image', async () => {
    const previous = encodeSzd(makeDocument('Song A'));
    const replacement = encodeSzd(makeDocument('Song A', { assetId: 'newAsset' }));
    await saveProject('Song A', replacement); // state left by the crashed publish

    const root = await navigator.storage.getDirectory();
    const staging = await root.getDirectoryHandle('restore-staging', { create: true });
    const stage = await staging.getDirectoryHandle('interrupted-publish', { create: true });
    const previousHandle = await stage.getFileHandle('previous-Song%20A.szd', { create: true });
    const previousWritable = await previousHandle.createWritable();
    await previousWritable.write(previous);
    await previousWritable.close();
    const manifestHandle = await stage.getFileHandle('manifest.json', { create: true });
    const manifestWritable = await manifestHandle.createWritable();
    await manifestWritable.write(
      new TextEncoder().encode(
        JSON.stringify({
          version: 2,
          state: 'publishing',
          projects: [
            {
              name: 'Song A',
              file: 'Song%20A.szd',
              previousFile: 'previous-Song%20A.szd',
              revision: 'replacement',
            },
          ],
          assetIds: [],
          fontIds: [],
          projectPublishIntents: ['Song A'],
          assetPublishIntents: [],
          fontPublishIntents: [],
        }),
      ),
    );
    await manifestWritable.close();

    expect(await reclaimOrphanedRestoreStages()).toBe(1);
    expect(await loadProject('Song A')).toEqual(previous);
    await expect(staging.getDirectoryHandle('interrupted-publish')).rejects.toThrow();
  });

  it('removes media and a newly-created project named by an interrupted publish journal', async () => {
    const created = encodeSzd(
      makeDocument('Created', { assetId: 'crashAsset', fontId: 'crashFont' }),
    );
    await saveProject('Created', created);
    await saveAsset({ id: 'crashAsset', name: 'Crash asset', sampleRate: 48000 }, stereo());
    await saveFont({ id: 'crashFont', name: 'Crash font' }, sf2(1, 2, 3));

    const root = await navigator.storage.getDirectory();
    const staging = await root.getDirectoryHandle('restore-staging', { create: true });
    const stage = await staging.getDirectoryHandle('interrupted-create', { create: true });
    const manifestHandle = await stage.getFileHandle('manifest.json', { create: true });
    const manifestWritable = await manifestHandle.createWritable();
    await manifestWritable.write(
      new TextEncoder().encode(
        JSON.stringify({
          version: 2,
          state: 'publishing',
          projects: [
            {
              name: 'Created',
              file: 'Created.szd',
              revision: 'created',
            },
          ],
          assetIds: ['crashAsset'],
          fontIds: ['crashFont'],
          projectPublishIntents: ['Created'],
          assetPublishIntents: ['crashAsset'],
          fontPublishIntents: ['crashFont'],
        }),
      ),
    );
    await manifestWritable.close();

    expect(await reclaimOrphanedRestoreStages()).toBe(1);
    await expect(loadProject('Created')).rejects.toThrow();
    await expect(loadAsset('crashAsset')).rejects.toThrow();
    await expect(loadFont('crashFont')).rejects.toThrow();
  });

  it('recovers a complete old or new namespace after a crash at every publish boundary', async () => {
    const replacement = encodeSzd(
      makeDocument('Song A', { assetId: 'restoreAsset', fontId: 'restoreFont' }),
    );
    await saveProject('Song A', replacement);
    await saveAsset({ id: 'restoreAsset', name: 'Restored audio', sampleRate: 48000 }, stereo());
    await saveFont({ id: 'restoreFont', name: 'Restored font' }, sf2(4, 5, 6));
    const archivedRevision = await saveProjectRevision(
      'Song A',
      'restore checkpoint',
      replacement,
      1000,
    );
    const backup = await createBrowserBackup('2026-07-23T00:00:00.000Z');
    const previous = encodeSzd(makeDocument('Song A'));
    const points = [
      'asset-intent',
      'asset-published',
      'font-intent',
      'font-published',
      'project-intent',
      'project-published',
      'revision-index-intent',
      'revision-index-published',
      'finalized',
    ] as const;

    for (const point of points) {
      uninstallMockOpfs();
      installMockOpfs();
      clearAudioAssetCache();
      clearFontCache();
      await saveProject('Song A', previous);
      setBrowserBackupRestoreFaultInjectorForTests((candidate) => candidate === point);

      await expect(restoreBrowserBackup(backup)).rejects.toThrow(
        `Simulated browser backup restore crash after ${point}`,
      );
      setBrowserBackupRestoreFaultInjectorForTests(null);

      expect(await reclaimOrphanedRestoreStages()).toBe(1);
      if (point === 'finalized') {
        expect(await loadProject('Song A')).toEqual(replacement);
        expect((await loadAsset('restoreAsset')).channels).toEqual(stereo());
        expect(await loadFont('restoreFont')).toEqual(sf2(4, 5, 6));
        expect(await listProjectRevisions('Song A')).toEqual([archivedRevision]);
        expect(await loadProjectRevision(archivedRevision.slot)).toEqual(replacement);
      } else {
        expect(await loadProject('Song A')).toEqual(previous);
        await expect(loadAsset('restoreAsset')).rejects.toThrow();
        await expect(loadFont('restoreFont')).rejects.toThrow();
        expect(await listProjectRevisions('Song A')).toEqual([]);
      }
    }
  });

  it('keeps pre-images distinct from projects whose names start with previous-', async () => {
    const oldMix = encodeSzd(makeDocument('Mix'));
    const oldPreviousMix = encodeSzd(makeDocument('previous-Mix'));
    await saveProject('Mix', oldMix);
    await saveProject('previous-Mix', oldPreviousMix);

    const replacementMix = encodeSzd(makeDocument('Mix', { assetId: 'replacement-mix' }));
    const replacementPreviousMix = encodeSzd(
      makeDocument('previous-Mix', { assetId: 'replacement-previous-mix' }),
    );
    await saveProject('Mix', replacementMix);
    await saveProject('previous-Mix', replacementPreviousMix);
    const backup = await createBrowserBackup('2026-07-29T00:00:00.000Z');
    await saveProject('Mix', oldMix);
    await saveProject('previous-Mix', oldPreviousMix);

    setBrowserBackupRestoreFaultInjectorForTests((point) => point === 'project-published');
    await expect(restoreBrowserBackup(backup)).rejects.toThrow(
      'Simulated browser backup restore crash after project-published',
    );
    setBrowserBackupRestoreFaultInjectorForTests(null);

    expect(await reclaimOrphanedRestoreStages()).toBe(1);
    expect(await loadProject('Mix')).toEqual(oldMix);
    expect(await loadProject('previous-Mix')).toEqual(oldPreviousMix);
  });

  it('reclaims orphaned staging namespaces through the startup maintenance entrypoint', async () => {
    await seedOrphanStage('startup-orphan');

    expect(await reclaimOrphanedRestoreStagesAtStartup()).toBe(1);
  });

  it('returns zero when no staging root was ever created', async () => {
    expect(await reclaimOrphanedRestoreStages()).toBe(0);
  });

  it('sweeps a leaked staging namespace at the start of the next restore', async () => {
    await seedOrphanStage('dead-txn');
    const backup = await createBrowserBackup('2026-07-19T00:00:00.000Z');

    await restoreBrowserBackup(backup);

    const root = await navigator.storage.getDirectory();
    const staging = await root.getDirectoryHandle('restore-staging');
    await expect(staging.getDirectoryHandle('dead-txn')).rejects.toThrow();
  });
});
