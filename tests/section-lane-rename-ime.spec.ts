import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SectionLane from '@/components/arrangement/SectionLane.vue';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { TimelineRange } from '@/ui/canvas/timeline-range';
import { enterKey } from './ime-test-helpers';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('SectionLane rename with an IME', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.sections = [{ id: 1, name: 'Intro', color: '#60a5fa', startPpq: 0, endPpq: 4 }];
  });

  async function startRename() {
    const wrapper = mount(SectionLane, {
      props: {
        range: new TimelineRange({ widthPx: 400, heightPx: 24, pxPerPpq: 80 }),
        revision: 0,
      },
    });
    await wrapper.find('.section-band').trigger('dblclick');
    const input = wrapper.find<HTMLInputElement>('.section-name-input');
    await input.setValue('にほ');
    return { wrapper, input };
  }

  it('keeps editing when Enter confirms a composition', async () => {
    const { wrapper, input } = await startRename();
    const event = enterKey(true);
    input.element.dispatchEvent(event);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.section-name-input').exists()).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });

  it('commits on a plain Enter', async () => {
    const { wrapper, input } = await startRename();
    input.element.dispatchEvent(enterKey(false));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.section-name-input').exists()).toBe(false);
  });
});
