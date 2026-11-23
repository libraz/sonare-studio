import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { promptDialog } from '@/composables/useDialogs';
import { useProjectPersistence } from '@/composables/useProjectPersistence';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

vi.mock('@/persistence/opfs', () => ({
  InvalidProjectNameError: class InvalidProjectNameError extends Error {},
  deleteProject: vi.fn(),
  isOpfsAvailable: () => true,
  isReservedProjectName: vi.fn(() => false),
  listProjectNames: vi.fn(async () => []),
  listProjects: vi.fn(async () => []),
  loadProjectWithRevision: vi.fn(),
  renameProject: vi.fn(),
  sanitizeProjectName: (name: string) => name.trim(),
  saveProjectChecked: vi.fn(),
}));

vi.mock('@/persistence/revisions', () => ({
  deleteProjectRevision: vi.fn(),
  deleteProjectRevisions: vi.fn(),
  listProjectRevisions: vi.fn(async () => []),
  loadProjectRevision: vi.fn(),
  saveProjectRevision: vi.fn(),
}));

vi.mock('@/composables/useDialogs', () => ({
  promptDialog: vi.fn(async () => 'Renamed'),
}));

/** Persistence wired to a guard that refuses every action, as while another one runs. */
function setupBusy() {
  const errorMessage = ref('');
  const confirmAction = vi.fn<Parameters<typeof useProjectPersistence>[0]['confirmAction']>(
    async () => true,
  );
  const persistence = useProjectPersistence({
    autosave: {
      lastSavedAt: ref<Date | null>(null),
      lastSavedDocumentKey: ref<string | null>(null),
      saving: ref(false),
      lastError: ref<Error | null>(null),
      saveNow: vi.fn(async () => true),
      restoreAutosave: vi.fn(async () => false),
      cancelPending: vi.fn(),
      dispose: vi.fn(),
    },
    confirmAction,
    confirmLossAction: confirmAction,
    errorMessage,
    runAction: async () => {
      errorMessage.value = 'busy';
    },
  });
  persistence.dirty.value = true;
  return { confirmAction, errorMessage, persistence };
}

describe('useProjectPersistence while another action runs', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useProjectStore().dispose();
    vi.mocked(promptDialog).mockClear();
  });

  const entries: [string, (p: ReturnType<typeof setupBusy>['persistence']) => unknown][] = [
    ['opening a stored project', (p) => p.openStoredProject('Stored')],
    ['importing an .szd file', (p) => p.importSzdFile()],
    ['restoring a revision', (p) => p.restoreRevision('Stored@1')],
    ['deleting a stored project', (p) => p.deleteStoredProject('Stored')],
    ['renaming a stored project', (p) => p.renameStoredProject('Stored')],
  ];

  it.each(entries)('reports busy without asking first when %s', async (_name, run) => {
    const { confirmAction, errorMessage, persistence } = setupBusy();

    await run(persistence);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(confirmAction).not.toHaveBeenCalled();
    expect(promptDialog).not.toHaveBeenCalled();
    expect(errorMessage.value).toBe('busy');
  });
});
