import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHistory, editRevision, redo, setTrackVolume, undo } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('history edit revision', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('advances on every committed edit, undo and redo', () => {
    const store = useProjectStore();
    const trackId = store.tracks[0].id;
    const start = editRevision.value;

    setTrackVolume(trackId, 0.5);
    const afterEdit = editRevision.value;
    expect(afterEdit).toBeGreaterThan(start);

    expect(undo()).toBe(true);
    const afterUndo = editRevision.value;
    expect(afterUndo).toBeGreaterThan(afterEdit);

    expect(redo()).toBe(true);
    expect(editRevision.value).toBeGreaterThan(afterUndo);
  });

  it('stays put when nothing can be undone', () => {
    const start = editRevision.value;
    expect(undo()).toBe(false);
    expect(editRevision.value).toBe(start);
  });
});
