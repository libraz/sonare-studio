import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMidiLearn } from '@/composables/useMidiLearn';
import { canRedo, canUndo, clearHistory, redo, undo } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('useMidiLearn stale binding cleanup', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('removes a stale target through history so undo restores the binding', () => {
    const learn = useMidiLearn();
    const id = 'gain:999999';

    learn.armId(id);
    learn.handleCc({ channel: 0, controller: 20, value: 90 });

    expect(learn.bindingForId(id)).toBeUndefined();
    expect(canUndo()).toBe(true);

    expect(undo()).toBe(true);
    expect(learn.bindingForId(id)).toEqual({ channel: 0, controller: 20 });
    expect(canRedo()).toBe(true);

    expect(redo()).toBe(true);
    expect(learn.bindingForId(id)).toBeUndefined();
  });
});
