import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';
import { addTrack, canRedo, canUndo, clearHistory, redo, undo } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('history availability reactivity', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('canUndo and canRedo computeds follow edit, undo, redo and clearHistory', () => {
    const undoable = computed(() => canUndo());
    const redoable = computed(() => canRedo());
    expect([undoable.value, redoable.value]).toEqual([false, false]);

    addTrack({ name: 'Bass' });
    expect([undoable.value, redoable.value]).toEqual([true, false]);

    undo();
    expect([undoable.value, redoable.value]).toEqual([false, true]);

    redo();
    expect([undoable.value, redoable.value]).toEqual([true, false]);

    undo();
    clearHistory();
    expect([undoable.value, redoable.value]).toEqual([false, false]);
  });
});
