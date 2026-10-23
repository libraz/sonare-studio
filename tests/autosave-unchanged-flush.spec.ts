import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { liveDocumentFlushes, useAutosave } from '@/composables/useAutosave';
import { addNote, clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const mocks = vi.hoisted(() => ({
  saveProject: vi.fn<(name: string, bytes: Uint8Array) => Promise<void>>(),
  saveAutosaveSessionRevision:
    vi.fn<(bytes: Uint8Array, key: string, savedAt: string) => Promise<void>>(),
}));

vi.mock('@/persistence/opfs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence/opfs')>()),
  saveProject: mocks.saveProject,
}));

vi.mock('@/persistence/recovery', () => ({
  saveAutosaveSessionRevision: mocks.saveAutosaveSessionRevision,
  loadLatestAutosaveSessionRevision: vi.fn(async () => null),
}));

describe('autosave exit flush', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    mocks.saveProject.mockReset();
    mocks.saveProject.mockResolvedValue(undefined);
    mocks.saveAutosaveSessionRevision.mockReset();
    mocks.saveAutosaveSessionRevision.mockResolvedValue(undefined);
  });

  function exitFlush() {
    const autosave = effectScope().run(() => useAutosave({ intervalMs: 60_000 }));
    if (!autosave) throw new Error('effect scope did not run');
    const { flushOnExit } = liveDocumentFlushes({
      hasLiveDocument: () => true,
      saveNow: autosave.saveNow,
    });
    return { autosave, flushOnExit };
  }

  it('writes nothing when the document has not changed since the last save', async () => {
    const { autosave, flushOnExit } = exitFlush();
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    await expect(flushOnExit()).resolves.toBe(true);
    const savedAt = mocks.saveAutosaveSessionRevision.mock.calls[0][2];
    const lastSavedAt = autosave.lastSavedAt.value;

    await expect(flushOnExit()).resolves.toBe(true);

    expect(mocks.saveProject).toHaveBeenCalledTimes(1);
    expect(mocks.saveAutosaveSessionRevision).toHaveBeenCalledTimes(1);
    expect(mocks.saveAutosaveSessionRevision.mock.calls[0][2]).toBe(savedAt);
    expect(autosave.lastSavedAt.value).toBe(lastSavedAt);
  });

  it('still writes a changed document and retries after a failed write', async () => {
    const { flushOnExit } = exitFlush();
    await flushOnExit();
    addNote({ pitch: 62, startPpq: 1, durationPpq: 1 });
    await flushOnExit();
    expect(mocks.saveProject).toHaveBeenCalledTimes(2);

    mocks.saveAutosaveSessionRevision.mockRejectedValueOnce(new Error('disk'));
    addNote({ pitch: 64, startPpq: 2, durationPpq: 1 });
    await expect(flushOnExit()).resolves.toBe(false);
    await expect(flushOnExit()).resolves.toBe(true);
    expect(mocks.saveProject).toHaveBeenCalledTimes(4);
  });
});
