import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';
import { executeApp } from '@/project/command/history';
import { canRedo, canUndo, clearHistory, redo, undo } from '@/project/commands';
import { loadProjectDocument } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { createTemplate } from '@/project/templates';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('project history availability reactivity', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    clearHistory();
  });

  it('updates computed undo and redo availability for commands, undo, redo and clear', () => {
    const undoAvailable = computed(() => canUndo());
    const redoAvailable = computed(() => canRedo());

    expect([undoAvailable.value, redoAvailable.value]).toEqual([false, false]);

    executeApp(() => {
      store.tracks[0].color = '#123456';
    });
    expect([undoAvailable.value, redoAvailable.value]).toEqual([true, false]);

    expect(undo()).toBe(true);
    expect([undoAvailable.value, redoAvailable.value]).toEqual([false, true]);

    expect(redo()).toBe(true);
    expect([undoAvailable.value, redoAvailable.value]).toEqual([true, false]);

    clearHistory();
    expect([undoAvailable.value, redoAvailable.value]).toEqual([false, false]);
  });

  it('tracks pending gesture availability and clears it on commit and project load', async () => {
    const undoAvailable = computed(() => canUndo());
    const redoAvailable = computed(() => canRedo());

    executeApp(
      () => {
        store.tracks[0].color = '#abcdef';
      },
      { key: 'track-color', commit: false },
    );
    expect([undoAvailable.value, redoAvailable.value]).toEqual([true, false]);

    executeApp(
      () => {
        store.tracks[0].color = '#fedcba';
      },
      { key: 'track-color', commit: true },
    );
    expect([undoAvailable.value, redoAvailable.value]).toEqual([true, false]);

    await loadProjectDocument(createTemplate('empty'));
    expect([undoAvailable.value, redoAvailable.value]).toEqual([false, false]);
  });

  it('keeps a gesture undoable when its final step is refused', () => {
    const before = store.tracks[0].color;
    executeApp(
      () => {
        store.tracks[0].color = '#abcdef';
      },
      { key: 'track-color', commit: false },
    );
    expect(() =>
      executeApp(
        () => {
          throw new RangeError('refused');
        },
        { key: 'track-color', commit: true },
      ),
    ).toThrow('refused');

    expect(canUndo()).toBe(true);
    expect(undo()).toBe(true);
    expect(store.tracks[0].color).toBe(before);
  });
});
