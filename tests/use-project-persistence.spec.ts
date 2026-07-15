import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { promptDialog } from '@/composables/useDialogs';
import { useProjectPersistence } from '@/composables/useProjectPersistence';
import { importDawprojectWithMediaResult } from '@/export/dawproject';
import { importMusicXmlInWorker } from '@/notation/musicxml-import-client';
import {
  pickAndReadDawproject,
  pickAndReadExternalAudioFiles,
  pickAndReadSzd,
  pickViaInputElement,
} from '@/persistence/local-file';
import { isReservedProjectName, listProjects, loadProject, saveProject } from '@/persistence/opfs';
import { encodeSzd } from '@/persistence/szd';
import {
  addNote,
  clearMixerSnapshots,
  saveMixerSnapshot,
  setProjectExternalMidiDefault,
} from '@/project/commands';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from '@/project/serialization';
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
  loadProject: vi.fn(),
  sanitizeProjectName: (name: string) =>
    name
      .trim()
      .replace(/\.szd$/i, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim(),
  saveProject: vi.fn(),
}));

vi.mock('@/composables/useDialogs', () => ({
  promptDialog: vi.fn(),
}));

vi.mock('@/persistence/local-file', () => ({
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
  })),
}));

vi.mock('@/persistence/backup', () => ({
  createBrowserBackup: vi.fn(async () => new Uint8Array([1, 2, 3])),
  restoreBrowserBackup: vi.fn(async () => ({ projects: 1, assets: 1, fonts: 1 })),
}));

vi.mock('@/persistence/bundle', () => ({
  gatherProjectBundle: vi.fn(),
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
  const saveNow = vi.fn(async () => options.autosaveResult ?? true);
  const errorMessage = ref('');
  const confirmAction = vi.fn(async () => true);
  const autosave = {
    lastSavedAt: ref<Date | null>(null),
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
    downloadBlobFile: vi.fn(),
    errorMessage,
    runAction: async (action) => {
      try {
        await action();
      } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : String(error);
      }
    },
  });
  return { autosave, confirmAction, errorMessage, persistence };
}

describe('useProjectPersistence autosave refresh after load', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearMixerSnapshots();
    vi.mocked(loadProject).mockReset();
    vi.mocked(saveProject).mockReset();
    vi.mocked(isReservedProjectName).mockReset();
    vi.mocked(isReservedProjectName).mockReturnValue(false);
    vi.mocked(promptDialog).mockReset();
    vi.mocked(importDawprojectWithMediaResult).mockClear();
    vi.mocked(listProjects).mockResolvedValue([]);
    vi.mocked(pickAndReadDawproject).mockReset();
    vi.mocked(pickAndReadExternalAudioFiles).mockReset();
    vi.mocked(pickAndReadSzd).mockReset();
    vi.mocked(pickViaInputElement).mockReset();
    vi.mocked(importMusicXmlInWorker).mockReset();
    localStorage.clear();
  });

  it('refreshes the autosave slot after opening a stored project', async () => {
    vi.mocked(loadProject).mockResolvedValue(encodeSzd(makeDocument('Stored Project')));
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
      expect.stringMatching(/2 lyric syllable.+1 harmony\/chord symbol/s),
      expect.objectContaining({ title: 'MusicXML import limitations' }),
    );
    expect(store.projectName).toBe('Current Project');
    expect(autosave.saveNow).not.toHaveBeenCalled();
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

  it('does not rename the live project when Save As rejects a reserved name', async () => {
    const store = useProjectStore();
    await store.init();
    store.projectName = 'Current Song';
    vi.mocked(isReservedProjectName).mockImplementation((name) => name === 'autosave');
    const errorMessage = ref('');
    const autosave = {
      lastSavedAt: ref<Date | null>(null),
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
    expect(saveProject).not.toHaveBeenCalled();
    expect(errorMessage.value).toContain('reserved');

    vi.mocked(promptDialog).mockResolvedValue('Recovered Song');
    errorMessage.value = '';
    persistence.saveProjectAsAction();
    await flushPromises();
    await nextTask();
    expect(errorMessage.value).toBe('');
    expect(saveProject).toHaveBeenCalledWith('Recovered Song', expect.any(Uint8Array));
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
    expect(saveProject).not.toHaveBeenCalled();
    expect(store.projectName).toBe('Current Song');

    confirmAction.mockResolvedValueOnce(true);
    persistence.saveProjectAsAction();
    await flushPromises();
    await nextTask();
    expect(saveProject).toHaveBeenCalledWith('Taken_Song', expect.any(Uint8Array));
    expect(store.projectName).toBe('Taken:Song');
  });

  it('keeps saving to the opened slot when the document title later changes', async () => {
    const store = useProjectStore();
    vi.mocked(loadProject).mockResolvedValue(encodeSzd(makeDocument('Original title')));
    const { persistence } = setup();
    await persistence.openStoredProject('Stored Slot');
    await flushPromises();
    vi.mocked(saveProject).mockClear();

    store.projectName = 'Edited title';
    persistence.saveProjectAction();
    await flushPromises();
    await nextTask();

    expect(saveProject).toHaveBeenCalledWith('Stored Slot', expect.any(Uint8Array));
  });

  it('does not clear dirty when edits land while a named save is in flight', async () => {
    const store = useProjectStore();
    await store.init();
    const { persistence } = setup();
    await persistence.markClean();
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    await flushPromises();
    let releaseSave: () => void = () => {};
    vi.mocked(saveProject).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve;
        }),
    );

    persistence.saveProjectAction();
    await vi.waitFor(() => expect(saveProject).toHaveBeenCalledTimes(1));
    addNote({ pitch: 64, startPpq: 1, durationPpq: 1 });
    releaseSave();
    await flushPromises();
    await nextTask();

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
});
