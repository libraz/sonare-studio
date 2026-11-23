import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TempoMapEditor from '@/components/lists/TempoMapEditor.vue';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { vTooltip } from '@/ui/tooltip';
import { enterKey } from './ime-test-helpers';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('TempoMapEditor Enter with an IME', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  async function edited() {
    const wrapper = mount(TempoMapEditor, { global: { directives: { tooltip: vTooltip } } });
    const input = wrapper.find<HTMLInputElement>('tbody input[type="number"]');
    await input.setValue('140');
    return { wrapper, input };
  }

  it('does not apply the draft when Enter confirms a composition', async () => {
    const { wrapper, input } = await edited();
    input.element.dispatchEvent(enterKey(true));
    await wrapper.vm.$nextTick();
    expect(store.tempoSegments).toEqual([{ startPpq: 0, bpm: 120 }]);
  });

  it('applies the draft on a plain Enter', async () => {
    const { wrapper, input } = await edited();
    input.element.dispatchEvent(enterKey(false));
    await wrapper.vm.$nextTick();
    expect(store.tempoSegments).toEqual([{ startPpq: 0, bpm: 140 }]);
  });
});
