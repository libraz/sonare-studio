import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TrackHeaderList from '@/components/arrangement/TrackHeaderList.vue';
import { addTrack, clearHistory, removeTrack } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { buildRowLayout } from '@/ui/arrangement/automation-rows';
import { vTooltip } from '@/ui/tooltip';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

function mountHeaders() {
  const store = useProjectStore();
  return mount(TrackHeaderList, {
    props: {
      laneHeight: 48,
      scrollY: 0,
      rulerOffset: 24,
      rowLayout: buildRowLayout(
        store.tracks.map(() => false),
        48,
      ),
      recordInputDevices: [],
    },
    global: { directives: { tooltip: vTooltip } },
  });
}

describe('track header shift-click after the anchor track is gone', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('activates the clicked track instead of throwing', async () => {
    const store = useProjectStore();
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => addTrack({ name, kind: 'audio' }));
    const wrapper = mountHeaders();
    const rowOf = (id: number) =>
      wrapper.findAll('.track-header')[store.tracks.findIndex((track) => track.id === id)];

    await rowOf(ids[5]).trigger('click');
    removeTrack(ids[5]);
    await wrapper.vm.$nextTick();
    const errors: unknown[] = [];
    wrapper.vm.$.appContext.config.errorHandler = (error) => {
      errors.push(error);
    };
    await rowOf(ids[1]).trigger('click', { shiftKey: true });

    expect(errors).toEqual([]);
    expect(store.activeTrackId).toBe(ids[1]);
    expect([...store.trackSelection]).toEqual([ids[1]]);
  });
});
