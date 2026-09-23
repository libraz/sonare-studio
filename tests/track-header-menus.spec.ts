import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TrackHeaderList from '@/components/arrangement/TrackHeaderList.vue';
import { addTrack, clearHistory, setTrackLeadFollow, setTrackPercussion } from '@/project/commands';
import { PITCH_RANGE_PRESETS } from '@/project/pitch-range';
import { useProjectStore } from '@/project/store';
import { buildRowLayout } from '@/ui/arrangement/automation-rows';
import {
  type ContextMenuItem,
  closeContextMenu,
  useContextMenuState,
} from '@/ui/menu/context-menu';

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

/** Opens the header's right-click menu and returns its current items. */
async function openMenuFor(wrapper: ReturnType<typeof mountHeaders>, trackId: number) {
  const store = useProjectStore();
  const index = store.tracks.findIndex((track) => track.id === trackId);
  await wrapper.findAll('.track-header')[index].trigger('contextmenu', {
    clientX: 10,
    clientY: 10,
  });
  return useContextMenuState().items;
}

/** Children of the "Pitch range" submenu item. */
function pitchRangeChildren(items: ContextMenuItem[]): ContextMenuItem[] {
  return items.find((item) => item.id === 'pitch-range')?.children ?? [];
}

/** The "Follow melody" submenu item itself, so its own `disabled` can be checked. */
function leadFollowItem(items: ContextMenuItem[]): ContextMenuItem | undefined {
  return items.find((item) => item.id === 'lead-follow');
}

/** Children of the "Follow melody" submenu item. */
function leadFollowChildren(items: ContextMenuItem[]): ContextMenuItem[] {
  return leadFollowItem(items)?.children ?? [];
}

describe('track header menus (pitch range, lead follow)', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    closeContextMenu();
    vi.clearAllMocks();
    await store.init();
    trackId = store.tracks[0].id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('pitch range submenu', () => {
    it('marks "off" checked when the track has no saved range', async () => {
      const wrapper = mountHeaders();
      const children = pitchRangeChildren(await openMenuFor(wrapper, trackId));
      expect(children.find((item) => item.id === 'pitch-range-off')?.checked).toBe(true);
      for (const id of Object.keys(PITCH_RANGE_PRESETS)) {
        expect(children.find((item) => item.id === `pitch-range-${id}`)?.checked).toBe(false);
      }
    });

    it('sets a preset and checks it, then clears it back to off', async () => {
      const wrapper = mountHeaders();
      let children = pitchRangeChildren(await openMenuFor(wrapper, trackId));
      children.find((item) => item.id === 'pitch-range-alto')?.run?.();
      await wrapper.vm.$nextTick();

      children = pitchRangeChildren(await openMenuFor(wrapper, trackId));
      expect(store.tracks[0].pitchRange).toEqual(PITCH_RANGE_PRESETS.alto);
      expect(children.find((item) => item.id === 'pitch-range-alto')?.checked).toBe(true);
      expect(children.find((item) => item.id === 'pitch-range-off')?.checked).toBe(false);

      children.find((item) => item.id === 'pitch-range-off')?.run?.();
      await wrapper.vm.$nextTick();
      children = pitchRangeChildren(await openMenuFor(wrapper, trackId));
      expect(store.tracks[0].pitchRange).toBeUndefined();
      expect(children.find((item) => item.id === 'pitch-range-off')?.checked).toBe(true);
    });

    it('checks nothing when the saved range does not match any preset', async () => {
      store.tracks[0] = { ...store.tracks[0], pitchRange: { low: 10, high: 20 } };
      const wrapper = mountHeaders();
      const children = pitchRangeChildren(await openMenuFor(wrapper, trackId));
      expect(children.find((item) => item.id === 'pitch-range-off')?.checked).toBe(false);
      for (const id of Object.keys(PITCH_RANGE_PRESETS)) {
        expect(children.find((item) => item.id === `pitch-range-${id}`)?.checked).toBe(false);
      }
    });
  });

  describe('lead follow submenu', () => {
    it('lists eligible tracks only: not self, not percussion, not already following', async () => {
      const drumId = addTrack({ name: 'Kit' });
      setTrackPercussion(drumId, true);
      const followerId = addTrack({ name: 'Pad' });
      const otherLeadId = addTrack({ name: 'Other lead' });
      setTrackLeadFollow(followerId, otherLeadId);

      const wrapper = mountHeaders();
      const children = leadFollowChildren(await openMenuFor(wrapper, trackId));

      expect(children.find((item) => item.id === `lead-follow-${trackId}`)).toBeUndefined();
      expect(children.find((item) => item.id === `lead-follow-${drumId}`)).toBeUndefined();
      expect(children.find((item) => item.id === `lead-follow-${followerId}`)).toBeUndefined();
      expect(children.find((item) => item.id === `lead-follow-${otherLeadId}`)).toBeDefined();
    });

    it('selecting a candidate calls setTrackLeadFollow', async () => {
      const leadId = addTrack({ name: 'Lead' });
      const wrapper = mountHeaders();
      let children = leadFollowChildren(await openMenuFor(wrapper, trackId));
      children.find((item) => item.id === `lead-follow-${leadId}`)?.run?.();
      await wrapper.vm.$nextTick();

      children = leadFollowChildren(await openMenuFor(wrapper, trackId));
      expect(store.tracks.find((track) => track.id === trackId)?.leadFollow?.leadTrackId).toBe(
        leadId,
      );
      expect(children.find((item) => item.id === `lead-follow-${leadId}`)?.checked).toBe(true);
      expect(children.find((item) => item.id === 'lead-follow-off')?.checked).toBe(false);

      children.find((item) => item.id === 'lead-follow-off')?.run?.();
      await wrapper.vm.$nextTick();
      children = leadFollowChildren(await openMenuFor(wrapper, trackId));
      expect(store.tracks.find((track) => track.id === trackId)?.leadFollow).toBeUndefined();
      expect(children.find((item) => item.id === 'lead-follow-off')?.checked).toBe(true);
    });

    it('disables the "Follow melody" item when the track is percussion', async () => {
      setTrackPercussion(trackId, true);
      addTrack({ name: 'Lead' });
      const wrapper = mountHeaders();
      const items = await openMenuFor(wrapper, trackId);
      expect(leadFollowItem(items)?.disabled).toBe(true);
    });

    it('disables the "Follow melody" item when the track already leads a follower', async () => {
      const followerId = addTrack({ name: 'Backing' });
      setTrackLeadFollow(followerId, trackId);

      const wrapper = mountHeaders();
      const items = await openMenuFor(wrapper, trackId);
      expect(leadFollowItem(items)?.disabled).toBe(true);
    });

    it('leaves the "Follow melody" item enabled for an ordinary melody track', async () => {
      addTrack({ name: 'Lead' });
      const wrapper = mountHeaders();
      const items = await openMenuFor(wrapper, trackId);
      expect(leadFollowItem(items)?.disabled).toBeFalsy();
    });
  });
});
