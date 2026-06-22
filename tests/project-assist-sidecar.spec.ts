import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHistory, listAssistSidecars, redo, setAssistSidecar, undo } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('assist sidecars', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('writes a sidecar that reads back with its payload intact', () => {
    setAssistSidecar('assist.demo', 2, 0, 0, 1920, new Uint8Array([1, 2, 3]));
    const sidecars = listAssistSidecars();
    expect(sidecars).toHaveLength(1);
    expect(sidecars[0]).toMatchObject({
      moduleId: 'assist.demo',
      schemaVersion: 2,
      targetTrackId: 0,
      regionStartPpq: 0,
      regionEndPpq: 1920,
    });
    expect([...sidecars[0].payload]).toEqual([1, 2, 3]);
  });

  it('updates in place when the same module id + scope is written again', () => {
    setAssistSidecar('assist.demo', 1, 3, 0, 960, new Uint8Array([9]));
    setAssistSidecar('assist.demo', 2, 3, 0, 960, new Uint8Array([7, 7]));
    const sidecars = listAssistSidecars();
    expect(sidecars).toHaveLength(1);
    expect(sidecars[0].schemaVersion).toBe(2);
    expect([...sidecars[0].payload]).toEqual([7, 7]);
  });

  it('appends a distinct sidecar when the scope differs', () => {
    setAssistSidecar('assist.demo', 1, 0, 0, 960, new Uint8Array([1]));
    setAssistSidecar('assist.demo', 1, 1, 0, 960, new Uint8Array([2]));
    expect(listAssistSidecars()).toHaveLength(2);
  });

  it('is undoable and redoable', () => {
    setAssistSidecar('assist.demo', 1, 0, 0, 960, new Uint8Array([5]));
    expect(listAssistSidecars()).toHaveLength(1);
    expect(undo()).toBe(true);
    expect(listAssistSidecars()).toHaveLength(0);
    expect(redo()).toBe(true);
    expect(listAssistSidecars()).toHaveLength(1);
    expect([...listAssistSidecars()[0].payload]).toEqual([5]);
  });

  it('rejects invalid arguments', () => {
    const payload = new Uint8Array([0]);
    expect(() => setAssistSidecar('', 1, 0, 0, 1, payload)).toThrow(/moduleId/);
    expect(() => setAssistSidecar('m', 1.5, 0, 0, 1, payload)).toThrow(/schemaVersion/);
    expect(() => setAssistSidecar('m', -1, 0, 0, 1, payload)).toThrow(/schemaVersion/);
    expect(() => setAssistSidecar('m', 1, -1, 0, 1, payload)).toThrow(/targetTrackId/);
    expect(() => setAssistSidecar('m', 1, 0, -1, 1, payload)).toThrow(/regionStartPpq/);
    expect(() => setAssistSidecar('m', 1, 0, 5, 1, payload)).toThrow(/regionEndPpq must be >=/);
    expect(() => setAssistSidecar('m', 1, 0, 0, 1, [0] as unknown as Uint8Array)).toThrow(
      /payload/,
    );
  });
});
