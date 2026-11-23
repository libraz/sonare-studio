import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TrackHeaderList from '@/components/arrangement/TrackHeaderList.vue';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { buildRowLayout } from '@/ui/arrangement/automation-rows';
import { enterKey } from './ime-test-helpers';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('TrackHeaderList rename with an IME', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  async function startRename() {
    const store = useProjectStore();
    const wrapper = mount(TrackHeaderList, {
      props: {
        laneHeight: 48,
        scrollY: 0,
        rulerOffset: 24,
        rowLayout: buildRowLayout(
          store.tracks.map(() => false),
          48,
        ),
      },
    });
    await wrapper.find('.track-name').trigger('dblclick');
    const input = wrapper.find<HTMLInputElement>('.track-name-input');
    await input.setValue('おんがく');
    return { store, wrapper, input };
  }

  it('keeps editing when Enter confirms a composition', async () => {
    const { store, wrapper, input } = await startRename();
    const before = store.tracks[0].name;
    input.element.dispatchEvent(enterKey(true));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.track-name-input').exists()).toBe(true);
    expect(store.tracks[0].name).toBe(before);
  });

  it('commits on a plain Enter', async () => {
    const { store, wrapper, input } = await startRename();
    input.element.dispatchEvent(enterKey(false));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.track-name-input').exists()).toBe(false);
    expect(store.tracks[0].name).toBe('おんがく');
  });
});
