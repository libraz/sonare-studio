import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TrackHeaderList from '@/components/arrangement/TrackHeaderList.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import {
  addTrack,
  addVcaGroup,
  canUndo,
  clearHistory,
  setTrackSelection,
  undo,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { buildRowLayout } from '@/ui/arrangement/automation-rows';
import { vTooltip } from '@/ui/tooltip';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const DEVICES = [{ value: 'mic-2', label: 'Mic 2' }];

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
      recordInputDevices: DEVICES,
    },
    global: { directives: { tooltip: vTooltip } },
  });
}

/** Emits `change` on the routing picker of one track header. */
async function pick(
  wrapper: ReturnType<typeof mountHeaders>,
  trackId: number,
  className: string,
  value: string | number,
) {
  const store = useProjectStore();
  const index = store.tracks.findIndex((track) => track.id === trackId);
  const menu = wrapper
    .findAll('.track-header')
    [index].findAllComponents(SelectMenu)
    .find((candidate: VueWrapper) => candidate.classes().includes(className));
  if (!menu) throw new Error(`no ${className} picker on track ${trackId}`);
  menu.vm.$emit('change', value);
  await wrapper.vm.$nextTick();
}

describe('track header routing edits follow the multi-selection', () => {
  let store: ReturnType<typeof useProjectStore>;
  let a: number;
  let b: number;
  let c: number;
  let vca: string;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    a = addTrack({ name: 'A', kind: 'audio' });
    b = addTrack({ name: 'B', kind: 'audio' });
    c = addTrack({ name: 'C', kind: 'audio' });
    vca = addVcaGroup({ name: 'Drums' });
    clearHistory();
  });

  const track = (id: number) => store.tracks.find((entry) => entry.id === id);

  it('applies a VCA change to every selected track as one undo entry', async () => {
    setTrackSelection([a, b], a);
    const wrapper = mountHeaders();
    await pick(wrapper, a, 'track-vca-select', vca);
    expect(track(a)?.vcaId).toBe(vca);
    expect(track(b)?.vcaId).toBe(vca);
    expect(track(c)?.vcaId).toBeUndefined();
    expect(undo()).toBe(true);
    expect(canUndo()).toBe(false);
    expect(track(a)?.vcaId).toBeUndefined();
    expect(track(b)?.vcaId).toBeUndefined();
  });

  it('applies a record input channel change to every selected track', async () => {
    setTrackSelection([a, b], a);
    const wrapper = mountHeaders();
    await pick(wrapper, a, 'track-record-input-select', 2);
    expect(track(a)?.recordInputChannel).toBe(2);
    expect(track(b)?.recordInputChannel).toBe(2);
    expect(track(c)?.recordInputChannel).toBeUndefined();
    expect(undo()).toBe(true);
    expect(canUndo()).toBe(false);
  });

  it('applies a record input device change to every selected track', async () => {
    setTrackSelection([a, b], a);
    const wrapper = mountHeaders();
    await pick(wrapper, a, 'track-record-device-select', 'mic-2');
    expect(track(a)?.recordInputDeviceId).toBe('mic-2');
    expect(track(b)?.recordInputDeviceId).toBe('mic-2');
    expect(track(c)?.recordInputDeviceId).toBeUndefined();
    expect(undo()).toBe(true);
    expect(canUndo()).toBe(false);
  });

  it('edits only the touched track when it is outside the selection', async () => {
    setTrackSelection([a, b], a);
    const wrapper = mountHeaders();
    await pick(wrapper, c, 'track-vca-select', vca);
    await pick(wrapper, c, 'track-record-input-select', 1);
    await pick(wrapper, c, 'track-record-device-select', 'mic-2');
    expect(track(c)?.vcaId).toBe(vca);
    expect(track(c)?.recordInputChannel).toBe(1);
    expect(track(c)?.recordInputDeviceId).toBe('mic-2');
    for (const id of [a, b]) {
      expect(track(id)?.vcaId).toBeUndefined();
      expect(track(id)?.recordInputChannel).toBeUndefined();
      expect(track(id)?.recordInputDeviceId).toBeUndefined();
    }
    expect(store.trackSelection.has(a) && store.trackSelection.has(b)).toBe(true);
  });

  it('rejects a record input edit on a mixed audio and MIDI selection and shows the banner', async () => {
    const midi = addTrack({ name: 'Keys' });
    clearHistory();
    setTrackSelection([a, midi], a);
    const wrapper = mountHeaders();
    await pick(wrapper, a, 'track-record-input-select', 2);
    expect(track(a)?.recordInputChannel).toBeUndefined();
    expect(track(midi)?.recordInputChannel).toBeUndefined();
    expect(canUndo()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  });
});
