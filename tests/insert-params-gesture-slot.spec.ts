import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { addInsert, clearHistory } from '@/project/commands';
import type { MixerStrip } from '@/project/mixer';
import { listQuickControls } from '@/project/quick-controls';
import { useProjectStore } from '@/project/store';
import { useInsertParams } from '@/ui/mixer/use-insert-params';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('insert parameter gestures', () => {
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    trackId = store.tracks[0].id;
  });

  function threshold(index: number): number {
    const control = listQuickControls({ type: 'insert', trackId, index }).find(
      (entry) => entry.id === 'thresholdDb',
    );
    return control?.value as number;
  }

  it('commits a knob on the slot it was turned on, not on an open gesture of another slot', () => {
    addInsert(trackId, 'dynamics.compressor', { thresholdDb: -18 });
    addInsert(trackId, 'dynamics.compressor', { thresholdDb: -18 });
    const params = useInsertParams({
      props: { target: trackId },
      strip: computed(() => ({ inserts: [{}, {}] }) as unknown as MixerStrip),
      error: ref(''),
    });
    const controlOf = () =>
      params.expandedControls.value.find((entry) => entry.id === 'thresholdDb')!;

    params.toggleExpanded(0);
    params.onParamChange(controlOf(), -24, false);
    params.toggleExpanded(1);
    params.onParamChange(controlOf(), -30, true);

    expect(threshold(1)).toBe(-30);
    expect(threshold(0)).toBe(-24);
  });
});
