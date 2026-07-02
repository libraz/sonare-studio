import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useProjectPersistence } from '@/composables/useProjectPersistence';
import { pickAndReadSzd } from '@/persistence/local-file';
import { loadProject } from '@/persistence/opfs';
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
  isReservedProjectName: () => false,
  listProjects: vi.fn(async () => []),
  loadProject: vi.fn(),
  saveProject: vi.fn(),
}));

vi.mock('@/persistence/local-file', () => ({
  downloadSzd: vi.fn(),
  pickAndReadSzd: vi.fn(),
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
});
