import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TrackHeaderList from '@/components/arrangement/TrackHeaderList.vue';
import { addTrack, clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { buildRowLayout } from '@/ui/arrangement/automation-rows';
import { closeContextMenu } from '@/ui/menu/context-menu';
import { vTooltip } from '@/ui/tooltip';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const LANE_HEIGHT = 48;

/** Dispatches a pointer event carrying the coordinates the drag reads. */
async function pointer(
  grip: { element: Element; trigger: (type: string, init?: object) => Promise<void> },
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  clientY: number,
): Promise<void> {
  await grip.trigger(type, { button: 0, pointerId: 1, clientY });
}

describe('track header grip reorder drag', () => {
  let store: ReturnType<typeof useProjectStore>;
  let ids: number[];

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    closeContextMenu();
    await store.init();
    while (store.tracks.length < 3) addTrack();
    ids = store.tracks.map((track) => track.id);
  });

  function mountHeaders() {
    return mount(TrackHeaderList, {
      props: {
        laneHeight: LANE_HEIGHT,
        scrollY: 0,
        rulerOffset: 24,
        rowLayout: buildRowLayout(
          store.tracks.map(() => false),
          LANE_HEIGHT,
        ),
      },
      global: { directives: { tooltip: vTooltip } },
    });
  }

  function gripAt(wrapper: ReturnType<typeof mountHeaders>, index: number) {
    const grip = wrapper.findAll('.track-grip')[index];
    (grip.element as HTMLElement).setPointerCapture = vi.fn();
    return grip;
  }

  it('moves a track down to the row the pointer is released over', async () => {
    const wrapper = mountHeaders();
    const grip = gripAt(wrapper, 0);

    await pointer(grip, 'pointerdown', 100);
    await pointer(grip, 'pointermove', 100 + LANE_HEIGHT * 2);
    expect(wrapper.findAll('.track-header')[0].classes()).toContain('dragging');
    expect(wrapper.findAll('.track-header')[2].classes()).toContain('drop-target');
    await pointer(grip, 'pointerup', 100 + LANE_HEIGHT * 2);

    expect(store.tracks.map((track) => track.id)).toEqual([ids[1], ids[2], ids[0]]);
    expect(wrapper.find('.dragging').exists()).toBe(false);
  });

  it('moves a track up to the row the pointer is released over', async () => {
    const wrapper = mountHeaders();
    const grip = gripAt(wrapper, 2);

    await pointer(grip, 'pointerdown', 200);
    await pointer(grip, 'pointermove', 200 - LANE_HEIGHT * 2);
    await pointer(grip, 'pointerup', 200 - LANE_HEIGHT * 2);

    expect(store.tracks.map((track) => track.id)).toEqual([ids[2], ids[0], ids[1]]);
  });

  it('leaves the order unchanged when released on the starting row', async () => {
    const wrapper = mountHeaders();
    const grip = gripAt(wrapper, 1);

    await pointer(grip, 'pointerdown', 100);
    await pointer(grip, 'pointermove', 104);
    await pointer(grip, 'pointerup', 104);

    expect(store.tracks.map((track) => track.id)).toEqual(ids);
  });

  it('ignores a non-primary button', async () => {
    const wrapper = mountHeaders();
    const grip = gripAt(wrapper, 0);

    await grip.trigger('pointerdown', { button: 2, pointerId: 1, clientY: 100 });
    await pointer(grip, 'pointermove', 100 + LANE_HEIGHT * 2);
    await pointer(grip, 'pointerup', 100 + LANE_HEIGHT * 2);

    expect(store.tracks.map((track) => track.id)).toEqual(ids);
  });

  it('pointercancel abandons the drag and leaves the order unchanged', async () => {
    const wrapper = mountHeaders();
    const grip = gripAt(wrapper, 0);

    await pointer(grip, 'pointerdown', 100);
    await pointer(grip, 'pointermove', 100 + LANE_HEIGHT * 2);
    await pointer(grip, 'pointercancel', 100 + LANE_HEIGHT * 2);
    expect(wrapper.find('.dragging').exists()).toBe(false);
    await pointer(grip, 'pointerup', 100 + LANE_HEIGHT * 2);

    expect(store.tracks.map((track) => track.id)).toEqual(ids);
  });
});
