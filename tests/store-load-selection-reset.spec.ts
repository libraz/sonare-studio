import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureWasm } from '@/lib/wasm';
import { useProjectStore } from '@/project/store';
import { createTemplate } from '@/project/templates';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

describe('loadDocument selection', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    await store.init();
  });

  it('clears track and clip selections left over from the previous document', async () => {
    store.trackSelection = new Set([1, 2]);
    store.clipSelection = new Set([1]);
    store.selection = new Set([1]);

    await store.loadDocument(createTemplate('band'));

    expect([...store.trackSelection]).toEqual([store.activeTrackId]);
    // Only the loaded document's active clip, if any, stays selected.
    expect([...store.clipSelection]).toEqual(store.clipId >= 0 ? [store.clipId] : []);
    expect(store.clipSelection.has(1) && store.clipId !== 1).toBe(false);
    expect(store.selection.size).toBe(0);
  });

  it('restores track and clip selections when the load fails', async () => {
    const wasm = await ensureWasm();
    store.trackSelection = new Set([store.activeTrackId]);
    store.clipSelection = new Set([store.clipId]);
    const before = { track: new Set(store.trackSelection), clip: new Set(store.clipSelection) };
    // clearHistory runs after the mirror is reset, so the rollback has work to do.
    const spy = vi.spyOn(wasm.Project.prototype, 'clearHistory').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      await expect(store.loadDocument(createTemplate('band'))).rejects.toThrow('boom');
    } finally {
      spy.mockRestore();
    }
    expect(store.trackSelection).toEqual(before.track);
    expect(store.clipSelection).toEqual(before.clip);
  });
});
