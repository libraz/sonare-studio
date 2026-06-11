import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
import { useAutosave } from '@/composables/useAutosave';
import { ProjectNotFoundError } from '@/persistence/opfs';
import { decodeSzd, encodeSzd } from '@/persistence/szd';
import { addNote, clearHistory, setSelection } from '@/project/commands';
import { serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const opfsMocks = vi.hoisted(() => ({
  saveProject: vi.fn<(name: string, bytes: Uint8Array) => Promise<void>>(),
  loadProject: vi.fn<(name: string) => Promise<Uint8Array>>(),
}));

vi.mock('@/persistence/opfs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence/opfs')>();
  return {
    ...actual,
    saveProject: opfsMocks.saveProject,
    loadProject: opfsMocks.loadProject,
  };
});

/** Lets the watcher (microtask-flushed) observe the latest store change. */
async function flushWatchers(): Promise<void> {
  await nextTick();
}

describe('useAutosave', () => {
  let store: ReturnType<typeof useProjectStore>;
  let scope: ReturnType<typeof effectScope>;

  /** Runs useAutosave inside a fresh effect scope. */
  function createAutosave(options?: Parameters<typeof useAutosave>[0]) {
    scope = effectScope();
    const autosave = scope.run(() => useAutosave({ intervalMs: 1000, ...options }));
    if (!autosave) throw new Error('effect scope did not run');
    return autosave;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    opfsMocks.saveProject.mockReset();
    opfsMocks.saveProject.mockResolvedValue(undefined);
    opfsMocks.loadProject.mockReset();
  });

  afterEach(() => {
    scope?.stop();
    vi.useRealTimers();
  });

  it('writes the encoded document to the slot after the debounce interval', async () => {
    const autosave = createAutosave();
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    await flushWatchers();

    await vi.advanceTimersByTimeAsync(999);
    expect(opfsMocks.saveProject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(opfsMocks.saveProject).toHaveBeenCalledTimes(1);

    const [slot, bytes] = opfsMocks.saveProject.mock.calls[0];
    expect(slot).toBe('autosave');
    const doc = decodeSzd(bytes);
    expect(doc.tracks[0].clips[0].notes).toEqual([
      { pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
    ]);
    expect(autosave.lastSavedAt.value).toBeInstanceOf(Date);
    expect(autosave.lastError.value).toBeNull();
  });

  it('debounces: edits inside the quiet period collapse into one save', async () => {
    createAutosave();
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    await flushWatchers();
    await vi.advanceTimersByTimeAsync(500);
    addNote({ pitch: 62, startPpq: 1, durationPpq: 1 });
    await flushWatchers();

    // The second edit restarted the timer, so 999 ms later nothing saved yet.
    await vi.advanceTimersByTimeAsync(999);
    expect(opfsMocks.saveProject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(opfsMocks.saveProject).toHaveBeenCalledTimes(1);
    const doc = decodeSzd(opfsMocks.saveProject.mock.calls[0][1]);
    expect(doc.tracks[0].clips[0].notes).toHaveLength(2);
  });

  it('uses a custom slot name', async () => {
    const autosave = createAutosave({ slotName: 'backup-slot' });
    await autosave.saveNow();
    expect(opfsMocks.saveProject).toHaveBeenCalledWith('backup-slot', expect.any(Uint8Array));
  });

  it('ignores editor-only state changes (selection)', async () => {
    createAutosave();
    const id = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    await flushWatchers();
    await vi.advanceTimersByTimeAsync(1000);
    opfsMocks.saveProject.mockClear();

    setSelection([id]);
    await flushWatchers();
    await vi.advanceTimersByTimeAsync(2000);
    expect(opfsMocks.saveProject).not.toHaveBeenCalled();
  });

  it('saveNow flushes the pending debounce and saves immediately', async () => {
    const autosave = createAutosave();
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    await flushWatchers();

    await expect(autosave.saveNow()).resolves.toBe(true);
    expect(opfsMocks.saveProject).toHaveBeenCalledTimes(1);

    // The cancelled timer must not fire a second save.
    await vi.advanceTimersByTimeAsync(2000);
    expect(opfsMocks.saveProject).toHaveBeenCalledTimes(1);
  });

  it('exposes saving while a write is in flight', async () => {
    const autosave = createAutosave();
    let release: () => void = () => {};
    opfsMocks.saveProject.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = autosave.saveNow();
    await flushWatchers();
    expect(autosave.saving.value).toBe(true);
    release();
    await expect(pending).resolves.toBe(true);
    expect(autosave.saving.value).toBe(false);
  });

  it('records write failures in lastError and resolves false', async () => {
    const autosave = createAutosave();
    opfsMocks.saveProject.mockRejectedValueOnce(new Error('disk full'));
    await expect(autosave.saveNow()).resolves.toBe(false);
    expect(autosave.lastError.value?.message).toBe('disk full');

    // The next successful save clears the error.
    await expect(autosave.saveNow()).resolves.toBe(true);
    expect(autosave.lastError.value).toBeNull();
  });

  it('restoreAutosave loads the stored document back into the project', async () => {
    const autosave = createAutosave();
    addNote({ pitch: 72, startPpq: 2, durationPpq: 1 });
    store.projectName = 'Saved Song';
    const bytes = encodeSzd(serializeProject());
    opfsMocks.loadProject.mockResolvedValue(bytes);

    store.dispose();
    clearHistory();
    await store.init();
    expect(store.projectName).toBe('Untitled');

    await expect(autosave.restoreAutosave()).resolves.toBe(true);
    expect(opfsMocks.loadProject).toHaveBeenCalledWith('autosave');
    expect(store.projectName).toBe('Saved Song');
    expect(serializeProject().tracks[0].clips[0].notes).toEqual([
      { pitch: 72, velocity: 96, startPpq: 2, durationPpq: 1, channel: 0 },
    ]);
  });

  it('restoreAutosave returns false when no autosave exists', async () => {
    const autosave = createAutosave();
    opfsMocks.loadProject.mockRejectedValue(new ProjectNotFoundError('autosave'));
    await expect(autosave.restoreAutosave()).resolves.toBe(false);
    expect(autosave.lastError.value).toBeNull();
  });

  it('restoreAutosave surfaces corrupted archives as errors', async () => {
    const autosave = createAutosave();
    opfsMocks.loadProject.mockResolvedValue(new Uint8Array([1, 2, 3]));
    await expect(autosave.restoreAutosave()).rejects.toThrow(/zip/);
    expect(autosave.lastError.value).not.toBeNull();
  });

  it('stops autosaving after dispose', async () => {
    const autosave = createAutosave();
    autosave.dispose();
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    await flushWatchers();
    await vi.advanceTimersByTimeAsync(2000);
    expect(opfsMocks.saveProject).not.toHaveBeenCalled();
  });

  it('stopping the owning effect scope also stops autosaving', async () => {
    createAutosave();
    scope.stop();
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    await flushWatchers();
    await vi.advanceTimersByTimeAsync(2000);
    expect(opfsMocks.saveProject).not.toHaveBeenCalled();
  });
});
