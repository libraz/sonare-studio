import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ArrangementAnalysisPanel from '@/components/arrangement/ArrangementAnalysisPanel.vue';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('ArrangementAnalysisPanel outside-press dismissal', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('closes the popover on a press outside it and keeps it for presses inside', async () => {
    wrapper = mount(ArrangementAnalysisPanel, { attachTo: document.body });
    await wrapper.find('.ap-toggle').trigger('click');
    expect(wrapper.find('.ap-popover').exists()).toBe(true);

    wrapper.find('.ap-popover').element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.ap-popover').exists()).toBe(true);

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.ap-popover').exists()).toBe(false);
  });

  it('stops listening once the popover has closed', async () => {
    wrapper = mount(ArrangementAnalysisPanel, { attachTo: document.body });
    const remove = vi.spyOn(window, 'removeEventListener');
    await wrapper.find('.ap-toggle').trigger('click');
    await wrapper.find('.ap-toggle').trigger('click');
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    remove.mockRestore();
  });
});
