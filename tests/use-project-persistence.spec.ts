import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { promptDialog } from '@/composables/useDialogs';
import { useProjectPersistence } from '@/composables/useProjectPersistence';
import { importDawprojectWithMedia } from '@/export/dawproject';
import {
  pickAndReadDawproject,
  pickAndReadExternalAudioFiles,
  pickAndReadSzd,
} from '@/persistence/local-file';
import { isReservedProjectName, listProjects, loadProject, saveProject } from '@/persistence/opfs';
import { encodeSzd } from '@/persistence/szd';
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
}));

vi.mock('@/export/dawproject', () => ({
  importDawprojectWithMedia: vi.fn(async () => ({
    schemaVersion: 3,
    name: 'DAWproject Import',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [],
    markers: [],
    sections: [],
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

function setup() {
  const saveNow = vi.fn(async () => true);
  const autosave = {
    lastSavedAt: ref<Date | null>(null),
    saving: ref(false),
    lastError: ref<Error | null>(null),
    saveNow,
    restoreAutosave: vi.fn(async () => false),
    cancelPending: vi.fn(),
    dispose: vi.fn(),
  };
  const persistence = useProjectPersistence({
    autosave,
    confirmAction: vi.fn(async () => true),
    downloadBlobFile: vi.fn(),
    errorMessage: ref(''),
    runAction: async (action) => {
      await action();
    },
  });
  return { autosave, persistence };
}

describe('useProjectPersistence autosave refresh after load', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    vi.mocked(loadProject).mockReset();
    vi.mocked(saveProject).mockReset();
    vi.mocked(isReservedProjectName).mockReset();
    vi.mocked(isReservedProjectName).mockReturnValue(false);
    vi.mocked(promptDialog).mockReset();
    vi.mocked(importDawprojectWithMedia).mockClear();
    vi.mocked(listProjects).mockResolvedValue([]);
    vi.mocked(pickAndReadDawproject).mockReset();
    vi.mocked(pickAndReadExternalAudioFiles).mockReset();
    vi.mocked(pickAndReadSzd).mockReset();
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

    const options = vi.mocked(importDawprojectWithMedia).mock.calls[0]?.[1];
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
});
