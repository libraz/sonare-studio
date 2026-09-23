import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TrackHeaderList from '@/components/arrangement/TrackHeaderList.vue';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { buildRowLayout } from '@/ui/arrangement/automation-rows';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Mounts the header list with the geometry props it requires. */
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
    },
  });
}

describe('TrackHeaderList scroll reveal', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks the container to reveal the row and focuses without native scroll', async () => {
    let rafCallback: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallback = cb;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const focusSpy = vi.spyOn(HTMLInputElement.prototype, 'focus');

    const store = useProjectStore();
    const trackId = store.tracks[0].id;
    const wrapper = mountHeaders();

    await wrapper.find('.track-header .track-name').trigger('dblclick');
    expect(wrapper.emitted('revealTrack')).toEqual([[trackId]]);

    // The rename input only exists once Vue has flushed the editingTrackId
    // change; the real browser paints before rAF fires too.
    await wrapper.vm.$nextTick();
    rafCallback?.(0);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('reveals a newly added track', async () => {
    const wrapper = mountHeaders();
    const store = useProjectStore();
    const countBefore = store.tracks.length;

    await wrapper.find('.add-track').trigger('click');
    await wrapper.find('.add-track-items button').trigger('click');

    expect(store.tracks.length).toBe(countBefore + 1);
    const newTrackId = store.tracks[store.tracks.length - 1].id;
    expect(wrapper.emitted('revealTrack')).toEqual([[newTrackId]]);
  });
});
