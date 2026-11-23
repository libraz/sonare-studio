import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MixSuggestDialog from '@/components/mixer/MixSuggestDialog.vue';
import type { renderMixdownInWorker } from '@/export/client';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('MixSuggestDialog teardown', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('cancels the in-flight render when the dialog unmounts', () => {
    const cancel = vi.fn<() => void>();
    const render = vi.fn<typeof renderMixdownInWorker>(() => ({
      result: new Promise(() => {}),
      cancel,
    }));
    const wrapper = mount(MixSuggestDialog, {
      props: { open: true, loopEnabled: false, loopStartPpq: 0, loopEndPpq: 0, render },
      global: { stubs: { teleport: true } },
    });
    expect(render).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
