import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useProjectPersistence } from '@/composables/useProjectPersistence';
import {
  loadProjectWithRevision,
  ProjectRevisionConflictError,
  saveProjectChecked,
} from '@/persistence/opfs';
import { loadProjectRevision } from '@/persistence/revisions';
import { encodeSzd } from '@/persistence/szd';
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
  InvalidProjectNameError: class InvalidProjectNameError extends Error {},
  ProjectRevisionConflictError: class ProjectRevisionConflictError extends Error {},
  deleteProject: vi.fn(),
  isOpfsAvailable: () => true,
  isReservedProjectName: vi.fn(() => false),
  listProjectNames: vi.fn(async () => ['Shared']),
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
  const lastSavedDocumentKey = ref<string | null>(null);
  const errorMessage = ref('');
  const errors: unknown[] = [];
  const persistence = useProjectPersistence({
    autosave: {
      lastSavedAt: ref<Date | null>(null),
      lastSavedDocumentKey,
      saving: ref(false),
      lastError: ref<Error | null>(null),
      saveNow: vi.fn(async () => {
        lastSavedDocumentKey.value = JSON.stringify(serializeProject());
        return true;
      }),
      restoreAutosave: vi.fn(async () => false),
      cancelPending: vi.fn(),
      dispose: vi.fn(),
    },
    confirmAction: vi.fn(async () => true),
    confirmLossAction: vi.fn(async () => true),
    errorMessage,
    runAction: async (action) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    },
  });
  return { persistence, errors };
}

const nextTask = () => new Promise((resolve) => globalThis.setTimeout(resolve, 0));

describe('restoring a revision keeps the save baseline', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useProjectStore().dispose();
    vi.mocked(loadProjectRevision).mockResolvedValue(encodeSzd(makeDocument('Restored')));
  });

  it('reports a conflict when another tab saved the slot after this tab opened it', async () => {
    // The slot as tab A opened it, then as tab B saved it.
    let slotRevision = 'rev-a';
    vi.mocked(loadProjectWithRevision).mockImplementation(async () => ({
      bytes: encodeSzd(makeDocument('Shared')),
      revision: slotRevision,
    }));
    vi.mocked(saveProjectChecked).mockImplementation(async (_name, _bytes, expected) => {
      if (expected !== slotRevision) throw new ProjectRevisionConflictError('conflict');
      return 'rev-c';
    });
    const { persistence, errors } = setup();

    await persistence.openStoredProject('Shared');
    await flushPromises();
    slotRevision = 'rev-b';
    vi.mocked(loadProjectWithRevision).mockClear();

    persistence.restoreRevision('snapshot');
    await flushPromises();
    await nextTask();
    // The restore itself must have run, not failed before touching the baseline.
    expect(errors).toEqual([]);
    expect(loadProjectRevision).toHaveBeenCalledWith('snapshot');
    expect(useProjectStore().projectName).toBe('Restored');
    expect(loadProjectWithRevision).not.toHaveBeenCalled();

    persistence.saveProjectAction();
    await flushPromises();
    await nextTask();

    expect(saveProjectChecked).toHaveBeenLastCalledWith('Shared', expect.any(Uint8Array), 'rev-a');
    expect(errors.some((error) => error instanceof ProjectRevisionConflictError)).toBe(true);
  });
});
