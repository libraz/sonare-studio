import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addMasteringProcessor, clearHistory, setMasteringParam } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('choosing an amp rig on the mastering chain', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it("drops the previous rig's knob overrides, as on a track insert", () => {
    addMasteringProcessor('saturation.ampSim', { presetIndex: 0, drive: 0.8 });
    setMasteringParam(0, 'presetIndex', 1);
    expect(useProjectStore().mixer.masteringChain?.processors[0].params).toEqual({
      presetIndex: 1,
    });
  });

  it('reapplying the same rig still clears the overrides', () => {
    addMasteringProcessor('saturation.ampSim', { presetIndex: 1, drive: 0.8 });
    setMasteringParam(0, 'presetIndex', 1);
    expect(useProjectStore().mixer.masteringChain?.processors[0].params).toEqual({
      presetIndex: 1,
    });
  });
});
