import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { promptDialog } from '@/composables/useDialogs';
import { useProjectPersistence } from '@/composables/useProjectPersistence';
import { importDawprojectWithMediaResult } from '@/export/dawproject';
import { DEFAULT_XML_LIMITS } from '@/lib/xml-preflight';
import { importMusicXmlInWorker } from '@/notation/musicxml-import-client';
import { createBrowserBackupWithReport, restoreBrowserBackup } from '@/persistence/backup';
import { gatherProjectBundleWithReport } from '@/persistence/bundle';
import {
  downloadBrowserBackup,
  downloadSzd,
  pickAndReadBrowserBackup,
  pickAndReadDawproject,
  pickAndReadExternalAudioFiles,
  pickAndReadSzd,
  pickViaInputElement,
} from '@/persistence/local-file';
import {
  isReservedProjectName,
  listProjects,
  loadProjectWithRevision,
  renameProject,
  saveProjectChecked,
} from '@/persistence/opfs';
import { MAX_SMF_FILE_BYTES } from '@/persistence/resource-limits';
import { encodeSzd } from '@/persistence/szd';
import {
  addNote,
  clearMixerSnapshots,
  saveMixerSnapshot,
  setClipCcLane,
  setProjectExternalMidiDefault,
} from '@/project/commands';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

vi.mock('@/persistence/opfs', () => ({
  deleteProject: vi.fn(),
  isOpfsAvailable: () => true,
  isReservedProjectName: vi.fn(() => false),
  listProjects: vi.fn(async () => []),
  loadProjectWithRevision: vi.fn(),
  renameProject: vi.fn(),
  sanitizeProjectName: (name: string) =>
    name
      .trim()
      .replace(/\.szd$/i, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim(),
  saveProjectChecked: vi.fn(),
}));

vi.mock('@/composables/useDialogs', () => ({
  promptDialog: vi.fn(),
}));

vi.mock('@/persistence/local-file', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence/local-file')>()),
  downloadBrowserBackup: vi.fn(),
  downloadSzd: vi.fn(),
  pickAndReadBrowserBackup: vi.fn(),
  pickAndReadDawproject: vi.fn(),
  pickAndReadExternalAudioFiles: vi.fn(),
  pickAndReadSzd: vi.fn(),
  pickViaInputElement: vi.fn(),
}));

vi.mock('@/notation/musicxml-import-client', () => ({
  importMusicXmlInWorker: vi.fn(),
}));

vi.mock('@/export/dawproject', () => ({
  importDawprojectWithMediaResult: vi.fn(async () => ({
    document: {
      schemaVersion: 3,
      name: 'DAWproject Import',
      sampleRate: 48000,
      tempoSegments: [{ startPpq: 0, bpm: 120 }],
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      tracks: [],
      markers: [],
      sections: [],
    },
    media: { imported: [], issues: [] },
    losses: [],
  })),
}));

vi.mock('@/persistence/backup', () => ({
  createBrowserBackupWithReport: vi.fn(async () => ({
    bytes: new Uint8Array([1, 2, 3]),
    completeness: { complete: true, issues: [] },
  })),
  reclaimOrphanedRestoreStagesAtStartup: vi.fn(async () => 0),
  restoreBrowserBackup: vi.fn(async () => ({ projects: 1, assets: 1, fonts: 1 })),
}));

vi.mock('@/persistence/bundle', () => ({
  gatherProjectBundleWithReport: vi.fn(async () => ({
    bundle: { assets: [], fonts: [] },
    report: { complete: true, issues: [] },
  })),
  restoreProjectBundle: vi.fn(async () => undefined),
}));

function makeDocument(name: string): ProjectDocument {
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name,
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [],
    markers: [],
    sections: [],
  };
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function setup(options: { autosaveResult?: boolean; autosaveError?: Error } = {}) {
  const lastSavedDocumentKey = ref<string | null>(null);
  const saveNow = vi.fn(async () => {
    const saved = options.autosaveResult ?? true;
    if (saved) lastSavedDocumentKey.value = JSON.stringify(serializeProject());
    return saved;
  });
  const errorMessage = ref('');
  const confirmAction = vi.fn(async () => true);
  const downloadBlobFile = vi.fn();
  const autosave = {
    lastSavedAt: ref<Date | null>(null),
    lastSavedDocumentKey,
    saving: ref(false),
    lastError: ref<Error | null>(options.autosaveError ?? null),
    saveNow,
    restoreAutosave: vi.fn(async () => false),
    cancelPending: vi.fn(),
    dispose: vi.fn(),
  };
  const persistence = useProjectPersistence({
    autosave,
    confirmAction,
    confirmLossAction: confirmAction,
    downloadBlobFile,
    errorMessage,
    runAction: async (action) => {
      try {
        await action();
      } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : String(error);
      }
    },
  });
  return { autosave, confirmAction, downloadBlobFile, errorMessage, persistence };
}

describe('useProjectPersistence autosave refresh after load', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearMixerSnapshots();
    vi.mocked(loadProjectWithRevision).mockReset();
    vi.mocked(renameProject).mockReset();
    vi.mocked(loadProjectWithRevision).mockResolvedValue({
      bytes: encodeSzd(makeDocument('Stored Project')),
      revision: 'revision-1',
    });
    vi.mocked(saveProjectChecked).mockReset();
    vi.mocked(saveProjectChecked).mockResolvedValue('revision-2');
    vi.mocked(isReservedProjectName).mockReset();
    vi.mocked(isReservedProjectName).mockReturnValue(false);
    vi.mocked(promptDialog).mockReset();
    vi.mocked(importDawprojectWithMediaResult).mockClear();
    vi.mocked(listProjects).mockResolvedValue([]);
    vi.mocked(pickAndReadDawproject).mockReset();
    vi.mocked(pickAndReadBrowserBackup).mockReset();
    vi.mocked(pickAndReadExternalAudioFiles).mockReset();
    vi.mocked(pickAndReadSzd).mockReset();
    vi.mocked(pickViaInputElement).mockReset();
    vi.mocked(importMusicXmlInWorker).mockReset();
    vi.mocked(downloadBrowserBackup).mockReset();
    vi.mocked(downloadSzd).mockReset();
    vi.mocked(createBrowserBackupWithReport).mockReset();
    vi.mocked(createBrowserBackupWithReport).mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      completeness: { complete: true, issues: [] },
    });
    vi.mocked(restoreBrowserBackup).mockReset();
    vi.mocked(restoreBrowserBackup).mockResolvedValue({ projects: 1, assets: 1, fonts: 1 });
    vi.mocked(gatherProjectBundleWithReport).mockReset();
    vi.mocked(gatherProjectBundleWithReport).mockResolvedValue({
      bundle: { assets: [], fonts: [] },
      report: { complete: true, issues: [] },
    });
    localStorage.clear();
  });

  it('blocks incomplete portable exports until the user explicitly accepts the loss', async () => {
    await useProjectStore().init();
    const issue = {
      kind: 'audio-asset' as const,
      mediaId: 'missing-audio',
      role: 'clip' as const,
      reason: 'missing' as const,
      trackId: 1,
      clipId: 2,
    };
    vi.mocked(gatherProjectBundleWithReport).mockResolvedValue({
      bundle: { assets: [], fonts: [] },
      report: { complete: false, issues: [issue] },
    });
    vi.mocked(createBrowserBackupWithReport).mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      completeness: { complete: false, issues: [issue] },
    });
    const { confirmAction, persistence } = setup();
    confirmAction.mockResolvedValue(false);

    persistence.exportSzdAction();
    await flushPromises();
    persistence.exportBrowserBackupAction();
    await flushPromises();

    expect(confirmAction).toHaveBeenCalledTimes(2);
    expect(confirmAction.mock.calls[0][0]).toContain('missing-audio');
    expect(downloadSzd).not.toHaveBeenCalled();
    expect(downloadBrowserBackup).not.toHaveBeenCalled();
  });

  it('requires loss consent before exporting a MIDI 2.0 clip that omits expression data', async () => {
    const store = useProjectStore();
    await store.init();
    setClipCcLane(store.clipId, 1, 0, [{ ppq: 0, value: 64 }]);
    const { confirmAction, downloadBlobFile, persistence } = setup();
    confirmAction.mockResolvedValue(false);

    persistence.exportMidi2Action();
    await flushPromises();

    expect(confirmAction).toHaveBeenCalledWith(
      expect.stringContaining('expression'),
      expect.objectContaining({ confirmLabel: expect.any(String) }),
    );
    expect(downloadBlobFile).not.toHaveBeenCalled();
  });

  it('reports media ids skipped while restoring a browser backup', async () => {
    vi.mocked(pickAndReadBrowserBackup).mockResolvedValue({
      name: 'backup.sonare-backup',
      bytes: new Uint8Array([1, 2, 3]),
    });
    vi.mocked(restoreBrowserBackup).mockResolvedValue({
      projects: 1,
      assets: 0,
      fonts: 0,
      skippedAssetIds: ['bad-audio'],
      skippedFontIds: ['bad-font'],
    });
    const { confirmAction, persistence } = setup();

    persistence.importBrowserBackupAction();
    await flushPromises();

    expect(confirmAction).toHaveBeenCalledTimes(2);
    expect(confirmAction.mock.calls[1][0]).toContain('Audio: bad-audio');
    expect(confirmAction.mock.calls[1][0]).toContain('SoundFont: bad-font');
    expect(confirmAction.mock.calls[1][1]).toMatchObject({
      title: 'Some backup media was skipped',
    });
  });

  it('refreshes the autosave slot after opening a stored project', async () => {
    vi.mocked(loadProjectWithRevision).mockResolvedValue({
      bytes: encodeSzd(makeDocument('Stored Project')),
      revision: 'revision-1',
    });
    const { autosave, persistence } = setup();

    await persistence.openStoredProject('Stored Project');
    await flushPromises();

    expect(autosave.saveNow).toHaveBeenCalledTimes(1);
    expect(useProjectStore().projectName).toBe('Stored Project');
  });

  it('refreshes the autosave slot after importing an .szd file', async () => {
    vi.mocked(pickAndReadSzd).mockResolvedValue({
      name: 'imported.szd',
      bytes: encodeSzd(makeDocument('Imported Project')),
    });
    const { autosave, persistence } = setup();

    await persistence.importSzdFile();
    await flushPromises();

    expect(autosave.saveNow).toHaveBeenCalledTimes(1);
    expect(useProjectStore().projectName).toBe('Imported Project');
  });

  it('refreshes the autosave slot after importing a DAWproject file', async () => {
    vi.mocked(pickAndReadDawproject).mockResolvedValue({
      name: 'imported.dawproject',
      bytes: new Uint8Array([1, 2, 3]),
    });
    const { autosave, persistence } = setup();

    await persistence.importDawprojectAction();
    await flushPromises();

    expect(autosave.saveNow).toHaveBeenCalledTimes(1);
    expect(useProjectStore().projectName).toBe('DAWproject Import');
  });

  it('surfaces unsupported DAWproject time units after a successful import', async () => {
    vi.mocked(pickAndReadDawproject).mockResolvedValue({
      name: 'odd-units.dawproject',
      bytes: new Uint8Array([1, 2, 3]),
    });
    vi.mocked(importDawprojectWithMediaResult).mockResolvedValueOnce({
      document: makeDocument('Odd Units'),
      media: { imported: [], issues: [] },
      losses: [
        {
          kind: 'unsupported-time-unit',
          clipName: 'Vox',
          attribute: 'contentTimeUnit',
          unit: 'samples',
        },
      ],
    });
    const { errorMessage, persistence } = setup();

    await persistence.importDawprojectAction();
    await flushPromises();

    expect(useProjectStore().projectName).toBe('Odd Units');
    expect(errorMessage.value).toContain('1 unsupported time unit');
    expect(errorMessage.value).toContain('contentTimeUnit=samples');
  });

  it('surfaces unsupported nested DAWproject structures after a successful import', async () => {
    vi.mocked(pickAndReadDawproject).mockResolvedValue({
      name: 'nested-warp.dawproject',
      bytes: new Uint8Array([1, 2, 3]),
    });
    vi.mocked(importDawprojectWithMediaResult).mockResolvedValueOnce({
      document: makeDocument('Nested Warp'),
      media: { imported: [], issues: [] },
      losses: [
        {
          kind: 'unsupported-warp',
          clipName: 'Drum Loop',
          reason: 'time-units',
          timeUnit: 'seconds',
          contentTimeUnit: 'beats',
        },
      ],
    });
    const { errorMessage, persistence } = setup();

    await persistence.importDawprojectAction();
    await flushPromises();

    expect(useProjectStore().projectName).toBe('Nested Warp');
    expect(errorMessage.value).toContain('1 unsupported structure');
    expect(errorMessage.value).toContain('Drum Loop: warp time-units');
  });

  it('shows a structured MusicXML loss report and keeps the project when declined', async () => {
    const store = useProjectStore();
    await store.init();
    store.projectName = 'Current Project';
    vi.mocked(pickViaInputElement).mockResolvedValue({
      name: 'imported.musicxml',
      text: '<score-partwise version="4.0"/>',
    });
    vi.mocked(importMusicXmlInWorker).mockResolvedValue({
      document: makeDocument('Imported MusicXML'),
      report: {
        issues: [
          { feature: 'lyrics', count: 2 },
          { feature: 'harmony', count: 1 },
          { feature: 'tempo-conflicts', count: 1 },
        ],
      },
    });
    const { autosave, confirmAction, persistence } = setup();
    await persistence.markClean();
    confirmAction.mockResolvedValue(false);

    persistence.importMusicXmlAction();
    await flushPromises();

    expect(importMusicXmlInWorker).toHaveBeenCalledWith(
      '<score-partwise version="4.0"/>',
      'imported.musicxml',
    );
    expect(confirmAction).toHaveBeenCalledWith(
      expect.stringMatching(
        /2 lyric syllable.+1 harmony\/chord symbol.+1 conflicting tempo event/s,
      ),
      expect.objectContaining({ title: 'MusicXML import limitations' }),
    );
    expect(store.projectName).toBe('Current Project');
    expect(autosave.saveNow).not.toHaveBeenCalled();
  });

  it('rejects an oversized MusicXML file before reading it into a string', async () => {
    const text = vi.fn(async () => '<score-partwise version="4.0"/>');
    vi.mocked(pickViaInputElement).mockImplementationOnce(async (options) =>
      options.read([
        {
          name: 'too-large.musicxml',
          size: DEFAULT_XML_LIMITS.maxBytes + 1,
          text,
        } as File,
      ]),
    );
    const { errorMessage, persistence } = setup();

    persistence.importMusicXmlAction();
    await flushPromises();

    expect(text).not.toHaveBeenCalled();
    expect(importMusicXmlInWorker).not.toHaveBeenCalled();
    expect(errorMessage.value).toMatch(/too-large\.musicxml exceeds the .*XML limit/);
  });

  it('rejects an oversized MIDI file before invoking the wasm importer', async () => {
    const input = {
      files: [{ name: 'too-large.mid', size: MAX_SMF_FILE_BYTES + 1 } as File],
      value: 'chosen',
    } as unknown as HTMLInputElement;
    const { errorMessage, persistence } = setup();

    persistence.onMidiImportChange({ target: input } as unknown as Event);
    await flushPromises();

    expect(errorMessage.value).toMatch(/too-large\.mid.*too large.*limit 33554432/);
    expect(input.value).toBe('');
  });

  it('passes a resolver for DAWproject external audio file selection', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    vi.mocked(pickAndReadDawproject).mockResolvedValue({
      name: 'imported.dawproject',
      bytes: new Uint8Array([1, 2, 3]),
    });
    vi.mocked(pickAndReadExternalAudioFiles).mockResolvedValue([{ name: 'Vox.wav', bytes }]);
    const { persistence } = setup();

    await persistence.importDawprojectAction();
    await flushPromises();

    const options = vi.mocked(importDawprojectWithMediaResult).mock.calls[0]?.[1];
    await expect(options?.resolveExternalAudio?.('/Session Audio/Vox.wav')).resolves.toBe(bytes);
    await expect(options?.resolveExternalAudio?.('/Session Audio/Bass.wav')).resolves.toBeNull();
    expect(pickAndReadExternalAudioFiles).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit per-path selection for ambiguous external audio basenames', async () => {
    const drums = { name: 'Vox.wav', relativePath: 'Drums/Vox.wav', bytes: new Uint8Array([1]) };
    const vocals = {
      name: 'Vox.wav',
      relativePath: 'Vocals/Vox.wav',
      bytes: new Uint8Array([2]),
    };
    vi.mocked(pickAndReadDawproject).mockResolvedValue({
      name: 'imported.dawproject',
      bytes: new Uint8Array([1, 2, 3]),
    });
    vi.mocked(pickAndReadExternalAudioFiles)
      .mockResolvedValueOnce([vocals, drums])
      .mockResolvedValueOnce([vocals]);
    const { confirmAction, persistence } = setup();

    await persistence.importDawprojectAction();
    await flushPromises();
    const resolver = vi.mocked(importDawprojectWithMediaResult).mock.calls[0]?.[1]
      ?.resolveExternalAudio;

    await expect(resolver?.('/Session/Vox.wav')).resolves.toBe(vocals.bytes);
    expect(confirmAction).toHaveBeenCalledWith(
      expect.stringContaining('/Session/Vox.wav'),
      expect.objectContaining({ title: 'Choose external audio' }),
    );
    expect(pickAndReadExternalAudioFiles).toHaveBeenCalledTimes(2);
  });

  it('never auto-selects one of several same-name files when relink is declined', async () => {
    vi.mocked(pickAndReadDawproject).mockResolvedValue({
      name: 'imported.dawproject',
      bytes: new Uint8Array([1, 2, 3]),
    });
    vi.mocked(pickAndReadExternalAudioFiles).mockResolvedValue([
      { name: 'Vox.wav', relativePath: 'A/Vox.wav', bytes: new Uint8Array([1]) },
      { name: 'VOX.WAV', relativePath: 'B/VOX.WAV', bytes: new Uint8Array([2]) },
      { name: 'vox.wav', relativePath: 'C/vox.wav', bytes: new Uint8Array([3]) },
    ]);
    const { confirmAction, persistence } = setup();
    confirmAction.mockResolvedValue(false);

    await persistence.importDawprojectAction();
    await flushPromises();
    const resolver = vi.mocked(importDawprojectWithMediaResult).mock.calls[0]?.[1]
      ?.resolveExternalAudio;

    await expect(resolver?.('/Session/Vox.wav')).resolves.toBeNull();
    expect(pickAndReadExternalAudioFiles).toHaveBeenCalledTimes(1);
  });

  it('does not rename the live project when Save As rejects a reserved name', async () => {
    const store = useProjectStore();
    await store.init();
    store.projectName = 'Current Song';
    vi.mocked(isReservedProjectName).mockImplementation((name) => name === 'autosave');
    const errorMessage = ref('');
    const autosave = {
      lastSavedAt: ref<Date | null>(null),
      lastSavedDocumentKey: ref<string | null>(null),
      saving: ref(false),
      lastError: ref<Error | null>(null),
      saveNow: vi.fn(async () => true),
      restoreAutosave: vi.fn(async () => false),
      cancelPending: vi.fn(),
      dispose: vi.fn(),
    };
    const persistence = useProjectPersistence({
      autosave,
      confirmAction: vi.fn(async () => true),
      confirmLossAction: vi.fn(async () => true),
      downloadBlobFile: vi.fn(),
      errorMessage,
      runAction: async (action) => {
        try {
          await action();
        } catch (err) {
          errorMessage.value = err instanceof Error ? err.message : String(err);
        }
      },
    });

    vi.mocked(promptDialog).mockResolvedValueOnce('autosave');
    persistence.saveProjectAsAction();
    await flushPromises();
    await nextTask();

    expect(store.projectName).toBe('Current Song');
    expect(saveProjectChecked).not.toHaveBeenCalled();
    expect(errorMessage.value).toContain('reserved');

    vi.mocked(promptDialog).mockResolvedValue('Recovered Song');
    errorMessage.value = '';
    persistence.saveProjectAsAction();
    await flushPromises();
    await nextTask();
    expect(errorMessage.value).toBe('');
    expect(saveProjectChecked).toHaveBeenCalledWith('Recovered Song', expect.any(Uint8Array), null);
    expect(store.projectName).toBe('Recovered Song');
  });

  it('requires confirmation before Save As replaces a canonical-name collision', async () => {
    const store = useProjectStore();
    await store.init();
    store.projectName = 'Current Song';
    vi.mocked(listProjects).mockResolvedValue([{ name: 'Taken_Song', size: 10 }]);
    vi.mocked(promptDialog).mockResolvedValue('Taken:Song');
    const { confirmAction, persistence } = setup();
    confirmAction.mockResolvedValueOnce(false);

    persistence.saveProjectAsAction();
    await flushPromises();
    await nextTask();

    expect(confirmAction).toHaveBeenCalledWith(
      expect.stringContaining('Taken_Song'),
      expect.any(Object),
    );
    expect(saveProjectChecked).not.toHaveBeenCalled();
    expect(store.projectName).toBe('Current Song');

    confirmAction.mockResolvedValueOnce(true);
    persistence.saveProjectAsAction();
    await flushPromises();
    await nextTask();
    expect(saveProjectChecked).toHaveBeenCalledWith(
      'Taken_Song',
      expect.any(Uint8Array),
      'revision-1',
    );
    expect(store.projectName).toBe('Taken:Song');
  });

  it('uses the Save As overwrite path when an unsaved project uses an existing name', async () => {
    const store = useProjectStore();
    await store.init();
    store.projectName = 'Taken Song';
    vi.mocked(listProjects).mockResolvedValue([{ name: 'Taken Song', size: 10 }]);
    const { confirmAction, persistence } = setup();
    confirmAction.mockResolvedValueOnce(false);

    persistence.saveProjectAction();
    await flushPromises();
    await nextTask();

    expect(confirmAction).toHaveBeenCalledWith(
      expect.stringContaining('Taken Song'),
      expect.any(Object),
    );
    expect(saveProjectChecked).not.toHaveBeenCalled();

    confirmAction.mockResolvedValueOnce(true);
    persistence.saveProjectAction();
    await flushPromises();
    await nextTask();

    expect(saveProjectChecked).toHaveBeenCalledWith(
      'Taken Song',
      expect.any(Uint8Array),
      'revision-1',
    );
  });

  it('keeps saving to the opened slot when the document title later changes', async () => {
    const store = useProjectStore();
    vi.mocked(loadProjectWithRevision).mockResolvedValue({
      bytes: encodeSzd(makeDocument('Original title')),
      revision: 'revision-1',
    });
    const { persistence } = setup();
    await persistence.openStoredProject('Stored Slot');
    await flushPromises();
    vi.mocked(saveProjectChecked).mockClear();

    store.projectName = 'Edited title';
    persistence.saveProjectAction();
    await flushPromises();
    await nextTask();

    expect(saveProjectChecked).toHaveBeenCalledWith(
      'Stored Slot',
      expect.any(Uint8Array),
      'revision-1',
    );
  });

  it('does not clear dirty when edits land while a named save is in flight', async () => {
    const store = useProjectStore();
    await store.init();
    const { persistence } = setup();
    await persistence.markClean();
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    await flushPromises();
    let releaseSave: () => void = () => {};
    vi.mocked(saveProjectChecked).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseSave = () => resolve('revision-2');
        }),
    );

    persistence.saveProjectAction();
    await vi.waitFor(() => expect(saveProjectChecked).toHaveBeenCalledTimes(1));
    addNote({ pitch: 64, startPpq: 1, durationPpq: 1 });
    releaseSave();
    await flushPromises();
    await nextTask();

    expect(persistence.dirty.value).toBe(true);
  });

  it('does not clear an edit made while the post-load autosave is in flight', async () => {
    const store = useProjectStore();
    await store.init();
    const loaded = serializeProject();
    loaded.name = 'Loaded';
    vi.mocked(loadProjectWithRevision).mockResolvedValue({
      bytes: encodeSzd(loaded),
      revision: 'revision-1',
    });
    const { autosave, persistence } = setup();
    let releaseSave: () => void = () => {};
    autosave.saveNow.mockImplementationOnce(async () => {
      const savedRevision = JSON.stringify(serializeProject());
      await new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      autosave.lastSavedDocumentKey.value = savedRevision;
      return true;
    });

    void persistence.openStoredProject('Loaded');
    await vi.waitFor(() => expect(autosave.saveNow).toHaveBeenCalledTimes(1));
    addNote({ pitch: 67, startPpq: 2, durationPpq: 1 });
    await flushPromises();
    releaseSave();
    await flushPromises();
    await nextTask();

    expect(persistence.dirty.value).toBe(true);
    expect(autosave.cancelPending).not.toHaveBeenCalled();
    expect(store.notes.some((note) => note.pitch === 67)).toBe(true);
  });

  it('marks persisted score layout, scale, and pickup changes dirty', async () => {
    const store = useProjectStore();
    await store.init();
    const { persistence } = setup();
    await persistence.markClean();

    store.scoreDisplaySettings = { ...store.scoreDisplaySettings, viewZoom: 1.25 };
    await flushPromises();
    expect(persistence.dirty.value).toBe(true);

    await persistence.markClean();
    store.scaleHighlight = { ...store.scaleHighlight, enabled: false, rootPc: 7 };
    await flushPromises();
    expect(persistence.dirty.value).toBe(true);

    await persistence.markClean();
    store.pickupLengthPpq = 1;
    await flushPromises();
    expect(persistence.dirty.value).toBe(true);
  });

  it('marks external MIDI and mixer snapshot registry changes dirty', async () => {
    const store = useProjectStore();
    await store.init();
    const { persistence } = setup();
    await persistence.markClean();

    setProjectExternalMidiDefault({
      kind: 'external-midi',
      outputPortId: 'midi-out-1',
      channel: 3,
    });
    await flushPromises();
    expect(persistence.dirty.value).toBe(true);

    await persistence.markClean();
    saveMixerSnapshot('B');
    await flushPromises();
    expect(persistence.dirty.value).toBe(true);

    await persistence.markClean();
    clearMixerSnapshots();
    await flushPromises();
    expect(persistence.dirty.value).toBe(true);
  });

  it('keeps an imported project dirty when its required autosave fails', async () => {
    vi.mocked(pickAndReadSzd).mockResolvedValue({
      name: 'imported.szd',
      bytes: encodeSzd(makeDocument('Imported Project')),
    });
    const { errorMessage, persistence } = setup({
      autosaveResult: false,
      autosaveError: new Error('autosave quota exceeded'),
    });

    await persistence.importSzdFile();
    await flushPromises();
    await nextTask();

    expect(persistence.dirty.value).toBe(true);
    expect(errorMessage.value).toContain('autosave quota exceeded');
  });

  it('saves freshly after deleting the open project instead of a stale revision', async () => {
    await useProjectStore().init();
    vi.mocked(loadProjectWithRevision).mockResolvedValue({
      bytes: encodeSzd(makeDocument('Stored Project')),
      revision: 'revision-1',
    });
    const { persistence } = setup();

    await persistence.openStoredProject('Stored Project');
    await flushPromises();
    await nextTask();

    await persistence.deleteStoredProject('Stored Project');
    await flushPromises();
    await nextTask();

    vi.mocked(saveProjectChecked).mockClear();
    persistence.saveProjectAction();
    await flushPromises();
    await nextTask();

    // The deleted slot's revision baseline must not be reused: the next save is
    // a fresh write (expectedRevision null), not an optimistic check against a
    // slot that no longer exists.
    expect(saveProjectChecked).toHaveBeenCalled();
    expect(vi.mocked(saveProjectChecked).mock.calls.at(-1)?.[2]).toBeNull();
  });

  it('renames a saved project through the persistence UI action', async () => {
    const { persistence } = setup();
    vi.mocked(promptDialog).mockResolvedValueOnce('Renamed Project');

    await persistence.renameStoredProject('Stored Project');
    await flushPromises();

    expect(renameProject).toHaveBeenCalledWith('Stored Project', 'Renamed Project');
  });
});
