import { type DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TrackHeaderList from '@/components/arrangement/TrackHeaderList.vue';
import ChannelStrip from '@/components/mixer/ChannelStrip.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import {
  addAudioTrack,
  addGroupTrack,
  addMidiClip,
  addTrack,
  addVcaGroup,
  clearHistory,
  renameTrack,
  setStripPan,
  setTrackFrozen,
  setTrackGroup,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { buildRowLayout } from '@/ui/arrangement/automation-rows';
import { closeContextMenu, useContextMenuState } from '@/ui/menu/context-menu';
import { isItemDisabled } from '@/ui/menu/menu-items';
import { dbToFaderPosition } from '@/ui/mixer/db-scale';
import { vTooltip } from '@/ui/tooltip';
import { editorClip } from './fakes/project';
import { selectOption, selectValueText } from './helpers/select-menu';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const freezeMock = vi.hoisted(() => ({
  freezeTrack: vi.fn(async () => 'frozen-asset'),
  unfreezeTrack: vi.fn(),
  bounceTrackRange: vi.fn(async () => 1),
}));

vi.mock('@/project/freeze', () => freezeMock);

const flattenMock = vi.hoisted(() => ({ flattenTrackComps: vi.fn(async () => {}) }));

vi.mock('@/project/comp-flatten', async (importActual) => ({
  ...(await importActual<typeof import('@/project/comp-flatten')>()),
  flattenTrackComps: flattenMock.flattenTrackComps,
}));

/** Mounts the header list with the geometry props it requires. */
function mountHeaders(loop?: { enabled: boolean; startPpq: number; endPpq: number }) {
  return mount(TrackHeaderList, {
    props: {
      laneHeight: 48,
      scrollY: 0,
      rulerOffset: 24,
      rowLayout: buildRowLayout(
        useProjectStore().tracks.map(() => false),
        48,
      ),
      ...(loop
        ? { loopEnabled: loop.enabled, loopStartPpq: loop.startPpq, loopEndPpq: loop.endPpq }
        : {}),
    },
    global: { directives: { tooltip: vTooltip } },
  });
}

describe('track freeze / bounce UI', () => {
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

  it('cancels a pending rename focus frame on unmount', async () => {
    const requestAnimationFrame = vi.fn(() => 24);
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);
    const wrapper = mountHeaders();

    await wrapper.find('.track-name').trigger('dblclick');
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(24);
  });

  describe('audible track pan wiring', () => {
    it('shares one pan value between the arrangement and mixer strip', async () => {
      const headers = mountHeaders();
      const pan = headers.find<HTMLInputElement>('.mini-slider--pan');

      await pan.setValue('0.65');

      expect(store.tracks[0]).toMatchObject({ pan: 0.65, mixer: { pan: 0.65 } });
      const channel = mount(ChannelStrip, { props: { target: trackId }, shallow: true });
      expect(channel.findComponent({ name: 'MixerKnob' }).props('value')).toBe(0.65);

      setStripPan(trackId, -0.4);
      await headers.vm.$nextTick();
      expect(Number(pan.element.value)).toBe(-0.4);
    });

    it('does not expose a save-only pan control for group buses', () => {
      const groupId = addGroupTrack({ name: 'Group' });
      const headers = mount(TrackHeaderList, {
        props: {
          laneHeight: 48,
          scrollY: 0,
          rulerOffset: 24,
          rowLayout: buildRowLayout(
            store.tracks.map((track) => track.id === groupId),
            48,
          ),
          automationExpandedIds: [groupId],
          automationParams: { [groupId]: 'pan' },
        },
      });
      expect(headers.findAll('.mini-slider--pan')).toHaveLength(1);
      const groupAutomation = headers
        .findAllComponents({ name: 'TrackAutomationStrip' })
        .find((strip) => strip.props('track').id === groupId);
      expect(groupAutomation?.props('param')).toBe('faderDb');
      expect(groupAutomation?.props('options')).not.toContainEqual(
        expect.objectContaining({ value: 'pan' }),
      );

      const groupStrip = mount(ChannelStrip, { props: { target: groupId }, shallow: true });
      expect(groupStrip.find('.strip-pan').exists()).toBe(true);
      expect(groupStrip.findComponent({ name: 'MixerKnob' }).exists()).toBe(true);
    });
  });

  describe('TrackHeaderList multi-track selection', () => {
    it('range-selects headers and applies header color actions to the selection', async () => {
      const second = addTrack({ name: 'Strings 1' });
      const third = addTrack({ name: 'Strings 2' });
      const wrapper = mountHeaders();
      const headers = wrapper.findAll('.track-header');

      await headers[0].trigger('click');
      await headers[2].trigger('click', { shiftKey: true });
      expect(store.trackSelection).toEqual(new Set([trackId, second, third]));
      expect(headers.map((header) => header.attributes('aria-selected'))).toEqual([
        'true',
        'true',
        'true',
      ]);

      await headers[1].find('.track-swatch').trigger('click');
      expect(store.tracks.map((track) => track.color)).toEqual(['#34d399', '#34d399', '#34d399']);
    });

    it('applies group assignment and deletion to selected headers', async () => {
      const second = addTrack({ name: 'Strings 1' });
      const group = addGroupTrack({ name: 'Strings' });
      const wrapper = mountHeaders();
      const headers = wrapper.findAll('.track-header');
      await headers[0].trigger('click');
      await headers[1].trigger('click', { metaKey: true });

      await selectOption(wrapper, '.track-group-select', 'Strings');
      expect(store.tracks.find((track) => track.id === trackId)?.groupId).toBe(group);
      expect(store.tracks.find((track) => track.id === second)?.groupId).toBe(group);

      // Deletion asks for confirmation by default; this test covers the batch, not the dialog.
      const appSettings = useAppSettings();
      const confirmDestructive = appSettings.settings.confirmDestructive;
      appSettings.set('confirmDestructive', false);
      try {
        await headers[0].trigger('contextmenu', { clientX: 10, clientY: 10 });
        const remove = useContextMenuState().items.find((item) => item.id === 'delete');
        await remove?.run?.();
        expect(store.tracks.map((track) => track.id)).toEqual([group]);
      } finally {
        appSettings.set('confirmDestructive', confirmDestructive);
      }
    });

    it('collapses group members and can select a group as one batch', async () => {
      const group = addGroupTrack({ name: 'Strings' });
      setTrackGroup(trackId, group);
      const groupTrack = store.tracks.find((track) => track.id === group)!;
      const wrapper = mount(TrackHeaderList, {
        props: {
          laneHeight: 48,
          scrollY: 0,
          rulerOffset: 24,
          rowLayout: buildRowLayout([false], 48),
          tracks: [groupTrack],
          collapsedGroupIds: [group],
        },
      });

      expect(wrapper.findAll('.track-header')).toHaveLength(1);
      await wrapper.find('.group-collapse').trigger('click');
      expect(wrapper.emitted('toggleGroupCollapse')).toEqual([[group, false]]);

      await wrapper.find('.track-header').trigger('contextmenu', { clientX: 10, clientY: 10 });
      useContextMenuState()
        .items.find((item) => item.id === 'select-group-members')
        ?.run?.();
      expect(store.trackSelection).toEqual(new Set([group, trackId]));
    });
  });

  describe('track header volume', () => {
    it('uses the shared dB fader taper and writes the canonical strip gain', async () => {
      store.tracks[0] = { ...store.tracks[0], volume: 0.5 };
      const headers = mountHeaders();
      const volume = headers.find<HTMLInputElement>('.mini-slider');

      expect(Number(volume.element.value)).toBeCloseTo(dbToFaderPosition(-6.020599913), 2);
      await volume.setValue('0.75');
      expect(store.tracks[0]).toMatchObject({
        volume: 1,
        mixer: expect.objectContaining({ gainDb: 0 }),
      });

      await volume.setValue('0');
      expect(store.tracks[0]).toMatchObject({
        volume: 1,
        mixer: expect.objectContaining({ gainDb: -120 }),
      });
    });
  });

  describe('TrackHeaderList VCA picker', () => {
    it('assigns and clears VCA membership from the track header', async () => {
      addVcaGroup({ id: 'vca-drums', name: 'Drums VCA' });
      const wrapper = mountHeaders();

      expect(selectValueText(wrapper, '.track-vca-select')).toBe('No VCA');

      await selectOption(wrapper, '.track-vca-select', 'Drums VCA');
      expect(store.tracks[0].vcaId).toBe('vca-drums');
      expect(selectValueText(wrapper, '.track-vca-select')).toBe('Drums VCA');

      await selectOption(wrapper, '.track-vca-select', 'No VCA');
      expect(store.tracks[0].vcaId).toBeUndefined();
    });

    it('creates and assigns a VCA group from the track header context menu', async () => {
      const wrapper = mountHeaders();
      await wrapper.find('.track-header').trigger('contextmenu', { clientX: 10, clientY: 10 });

      const menu = useContextMenuState();
      const item = menu.items.find((entry) => entry.id === 'vca-new');
      expect(item?.label).toBe('New VCA group');

      item?.run?.();
      expect(store.mixer.vcaGroups).toHaveLength(1);
      expect(store.tracks[0].vcaId).toBe(store.mixer.vcaGroups?.[0]?.id);
    });

    it('offers instrument changes from MIDI track context menus', async () => {
      const wrapper = mountHeaders();
      await wrapper.find('.track-header').trigger('contextmenu', { clientX: 10, clientY: 10 });

      const menu = useContextMenuState();
      const item = menu.items.find((entry) => entry.id === 'change-instrument');
      expect(item?.label).toBe('Change instrument...');

      item?.run?.();
      expect(wrapper.emitted('changeInstrument')).toEqual([[trackId]]);
    });
  });

  describe('TrackHeaderList record input channel picker', () => {
    it('sets and clears an audio track recording input channel', async () => {
      const audioTrackId = addAudioTrack({ name: 'Mic' });
      const wrapper = mountHeaders();
      const headers = wrapper.findAll('.track-header');
      const audioHeader = headers.find((header) => header.text().includes('Mic'));
      expect(audioHeader).toBeDefined();

      expect(selectValueText(wrapper, '.track-record-input-select')).toBe('Auto');

      await selectOption(wrapper, '.track-record-input-select', 'Ch 3');
      expect(store.tracks.find((track) => track.id === audioTrackId)?.recordInputChannel).toBe(2);
      expect(selectValueText(wrapper, '.track-record-input-select')).toBe('Ch 3');

      await selectOption(wrapper, '.track-record-input-select', 'Auto');
      expect(
        store.tracks.find((track) => track.id === audioTrackId)?.recordInputChannel,
      ).toBeUndefined();
    });

    it('does not show recording input channels on MIDI or group tracks', () => {
      addGroupTrack();
      const wrapper = mountHeaders();
      const headers = wrapper.findAll('.track-header');
      expect(headers[0].find('.track-record-input-select').exists()).toBe(false);
      expect(headers[headers.length - 1].find('.track-record-input-select').exists()).toBe(false);
    });
  });

  describe('TrackHeaderList freeze toggle', () => {
    it('shows the freeze toggle on non-group tracks only', () => {
      addGroupTrack();
      const wrapper = mountHeaders();
      const headers = wrapper.findAll('.track-header');
      expect(headers[0].find('.toggle.freeze').exists()).toBe(true);
      expect(headers[headers.length - 1].find('.toggle.freeze').exists()).toBe(false);
    });

    it('freezes an unfrozen track with a busy state while the render is pending', async () => {
      let resolveFreeze!: (assetId: string) => void;
      freezeMock.freezeTrack.mockImplementationOnce(
        () => new Promise<string>((resolve) => (resolveFreeze = resolve)),
      );
      const wrapper = mountHeaders();
      const button = wrapper.find('.toggle.freeze');
      await button.trigger('click');
      expect(freezeMock.freezeTrack).toHaveBeenCalledWith(trackId);
      expect(button.attributes('disabled')).toBeDefined();
      expect(button.classes()).toContain('busy');
      resolveFreeze('frozen-asset');
      await flushPromises();
      expect(button.attributes('disabled')).toBeUndefined();
      expect(button.classes()).not.toContain('busy');
    });

    it('re-enables the toggle and shows the error when the freeze render fails', async () => {
      freezeMock.freezeTrack.mockRejectedValueOnce(new Error('render failed'));
      const wrapper = mountHeaders();
      const button = wrapper.find('.toggle.freeze');
      await button.trigger('click');
      await flushPromises();
      expect(wrapper.find('.headers-error').text()).toBe('render failed');
      expect(button.attributes('disabled')).toBeUndefined();
    });

    it('marks frozen headers and unfreezes on click', async () => {
      setTrackFrozen(trackId, { assetId: 'frozen-asset' });
      const wrapper = mountHeaders();
      const header = wrapper.find('.track-header');
      expect(header.classes()).toContain('track-frozen');
      const button = header.find('.toggle.freeze');
      expect(button.classes()).toContain('on');
      await button.trigger('click');
      expect(freezeMock.unfreezeTrack).toHaveBeenCalledWith(trackId);
      expect(freezeMock.freezeTrack).not.toHaveBeenCalled();
    });
  });

  describe('TrackHeaderList bounce button', () => {
    // The demo project seeds track 0 with a clip; bounce tests target a
    // fresh clipless track and scope to its own header row.
    let bounceTrackId: number;

    beforeEach(() => {
      bounceTrackId = addTrack({ name: 'Bounce target' });
    });

    function bounceButton(loop?: {
      enabled: boolean;
      startPpq: number;
      endPpq: number;
    }): DOMWrapper<Element> {
      const headers = mountHeaders(loop).findAll('.track-header');
      return headers[headers.length - 1].find('.track-bounce');
    }

    it('only appears on tracks with at least one clip', () => {
      expect(bounceButton().exists()).toBe(false);
      addMidiClip({ trackId: bounceTrackId, startPpq: 0, lengthPpq: 960 });
      expect(bounceButton().exists()).toBe(true);
    });

    it('bounces over the loop region when the loop is enabled and valid', async () => {
      addMidiClip({ trackId: bounceTrackId, startPpq: 0, lengthPpq: 960 });
      const button = bounceButton({ enabled: true, startPpq: 960, endPpq: 1920 });
      await button.trigger('click');
      expect(freezeMock.bounceTrackRange).toHaveBeenCalledWith(bounceTrackId, 960, 1920);
    });

    it('falls back to the full clip span when the loop is disabled or empty', async () => {
      addMidiClip({ trackId: bounceTrackId, startPpq: 480, lengthPpq: 960 });
      addMidiClip({ trackId: bounceTrackId, startPpq: 1920, lengthPpq: 480 });
      const button = bounceButton({ enabled: false, startPpq: 960, endPpq: 1920 });
      await button.trigger('click');
      expect(freezeMock.bounceTrackRange).toHaveBeenCalledWith(bounceTrackId, 480, 2400);
    });

    it('re-enables the button and shows the error when the bounce render fails', async () => {
      freezeMock.bounceTrackRange.mockRejectedValueOnce(new Error('render failed'));
      addMidiClip({ trackId: bounceTrackId, startPpq: 0, lengthPpq: 960 });
      const button = bounceButton();
      await button.trigger('click');
      await flushPromises();
      expect(
        button.element.closest('.track-headers')?.querySelector('.headers-error')?.textContent,
      ).toBe('render failed');
      expect(button.attributes('disabled')).toBeUndefined();
    });
  });

  describe('TrackHeaderList take flatten', () => {
    it('shows the error when flattening an audio track fails', async () => {
      const audioId = addAudioTrack();
      store.clips = [
        ...store.clips,
        editorClip({
          id: 9001,
          trackId: audioId,
          kind: 'audio',
          takes: [
            { assetId: 'take-a', name: 'Take 1' },
            { assetId: 'take-b', name: 'Take 2' },
          ],
        }),
      ];
      flattenMock.flattenTrackComps.mockRejectedValueOnce(new Error('flatten failed'));
      const wrapper = mount(TrackHeaderList, {
        props: {
          laneHeight: 48,
          scrollY: 0,
          rulerOffset: 24,
          rowLayout: buildRowLayout(
            store.tracks.map(() => false),
            48,
          ),
          takesExpandedIds: [audioId],
        },
        global: { directives: { tooltip: vTooltip } },
      });
      await wrapper.find('.takes-flatten').trigger('click');
      await flushPromises();
      expect(flattenMock.flattenTrackComps).toHaveBeenCalledWith(audioId);
      expect(wrapper.find('.headers-error').text()).toBe('flatten failed');
    });
  });

  describe('ChannelStrip frozen tag', () => {
    it('tags frozen tracks with a snowflake next to the name', () => {
      setTrackFrozen(trackId, { assetId: 'frozen-asset' });
      const wrapper = mount(ChannelStrip, { props: { target: trackId }, shallow: true });
      expect(wrapper.find('.strip-frozen-tag').exists()).toBe(true);
    });

    it('shows no tag on unfrozen tracks', () => {
      const wrapper = mount(ChannelStrip, { props: { target: trackId }, shallow: true });
      expect(wrapper.find('.strip-frozen-tag').exists()).toBe(false);
    });

    it('refuses to arm a frozen track and says why', () => {
      setTrackFrozen(trackId, { assetId: 'frozen-asset' });
      const arm = mountHeaders().find<HTMLButtonElement>('.toggle.arm');
      expect(arm.element.disabled).toBe(true);
      expect(arm.attributes('aria-description')).toContain('This track is frozen.');
    });

    it('disables frozen track rename from both header and mixer menus', async () => {
      renameTrack(trackId, 'Drums');
      setTrackFrozen(trackId, { assetId: 'frozen-asset' });
      const headers = mountHeaders();
      await headers.find('.track-name').trigger('dblclick');
      expect(headers.find('.track-name-input').exists()).toBe(false);
      await headers.find('.track-header').trigger('contextmenu', { clientX: 10, clientY: 10 });
      const rename = useContextMenuState().items.find((item) => item.id === 'rename');
      expect(rename && isItemDisabled(rename)).toBe(true);
      const regenerate = useContextMenuState().items.find((item) => item.id === 'regenerate');
      expect(regenerate && isItemDisabled(regenerate)).toBe(true);

      closeContextMenu();
      const strip = mount(ChannelStrip, { props: { target: trackId }, shallow: true });
      await strip.find('.channel-strip').trigger('contextmenu', { clientX: 10, clientY: 10 });
      const stripRename = useContextMenuState().items.find((item) => item.id === 'rename');
      expect(stripRename && isItemDisabled(stripRename)).toBe(true);
    });
  });
});
