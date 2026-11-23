import type { SoloProcessor } from '@libraz/libsonare';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addInsert, addMasteringProcessor, clearHistory, replaceInsert } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('every command that places a processor refuses an unknown one', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('replaceInsert, like addInsert', () => {
    const trackId = useProjectStore().tracks[0].id;
    expect(() => addInsert(trackId, 'eq.nonexistent')).toThrow(/Unknown insert processor/);
    const index = addInsert(trackId, 'eq.tilt');
    expect(() =>
      replaceInsert(trackId, index, { processor: 'eq.nonexistent', params: {}, enabled: true }),
    ).toThrow(/Unknown insert processor/);
  });

  it('addMasteringProcessor', () => {
    expect(() => addMasteringProcessor('eq.nonexistent' as SoloProcessor)).toThrow(
      /Unknown insert processor/,
    );
  });
});
