import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useAutosave } from '@/composables/useAutosave';
import { useProjectPersistence } from '@/composables/useProjectPersistence';
import { loadProject } from '@/persistence/opfs';
import { encodeSzd } from '@/persistence/szd';
import { serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

vi.mock('@/persistence/opfs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence/opfs')>()),
  isOpfsAvailable: () => true,
  listProjects: vi.fn(async () => []),
  listProjectNames: vi.fn(async () => []),
  loadProject: vi.fn(),
  saveProject: vi.fn(async () => undefined),
}));

vi.mock('@/persistence/recovery', () => ({
  saveAutosaveSessionRevision: vi.fn(async () => undefined),
  loadLatestAutosaveSessionRevision: vi.fn(async () => null),
}));

describe('Continue Session', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    await store.init();
  });

  it('runs the document-will-load hook exactly once, before the autosave replaces the project', async () => {
    const stored = serializeProject();
    stored.name = 'Recovered';
    vi.mocked(loadProject).mockResolvedValue(encodeSzd(stored));
    const store = useProjectStore();
    const namesAtHook: string[] = [];
    const onProjectDocumentWillLoad = vi.fn(() => {
      namesAtHook.push(store.projectName);
    });
    const persistence = useProjectPersistence({
      autosave: useAutosave(),
      confirmAction: vi.fn(async () => true),
      confirmLossAction: vi.fn(async () => true),
      errorMessage: ref(''),
      onProjectDocumentWillLoad,
      runAction: async (action) => {
        await action();
      },
    });

    persistence.continueSession();
    await flushPromises();

    expect(onProjectDocumentWillLoad).toHaveBeenCalledTimes(1);
    expect(namesAtHook).toEqual(['Untitled']);
    expect(store.projectName).toBe('Recovered');
  });
});
