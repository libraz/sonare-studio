import { type DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TrackHeaderList from '@/components/arrangement/TrackHeaderList.vue';
import ChannelStrip from '@/components/mixer/ChannelStrip.vue';
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
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { closeContextMenu, useContextMenuState } from '@/ui/menu/context-menu';
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

/** Mounts the header list with the geometry props it requires. */
function mountHeaders(loop?: { enabled: boolean; startPpq: number; endPpq: number }) {
  return mount(TrackHeaderList, {
    props: {
      laneHeight: 48,
      scrollY: 0,
      rulerOffset: 24,
      ...(loop
        ? { loopEnabled: loop.enabled, loopStartPpq: loop.startPpq, loopEndPpq: loop.endPpq }
        : {}),
    },
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
      expect(groupStrip.find('.strip-pan').exists()).toBe(false);
      expect(groupStrip.findComponent({ name: 'MixerKnob' }).exists()).toBe(false);
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

    it('re-enables the toggle and warns when the freeze render fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      freezeMock.freezeTrack.mockRejectedValueOnce(new Error('render failed'));
      const wrapper = mountHeaders();
      const button = wrapper.find('.toggle.freeze');
      await button.trigger('click');
      await flushPromises();
      expect(warn).toHaveBeenCalled();
      expect(button.attributes('disabled')).toBeUndefined();
      warn.mockRestore();
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

    it('re-enables the button and warns when the bounce render fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      freezeMock.bounceTrackRange.mockRejectedValueOnce(new Error('render failed'));
      addMidiClip({ trackId: bounceTrackId, startPpq: 0, lengthPpq: 960 });
      const button = bounceButton();
      await button.trigger('click');
      await flushPromises();
      expect(warn).toHaveBeenCalled();
      expect(button.attributes('disabled')).toBeUndefined();
      warn.mockRestore();
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

    it('disables frozen track rename from both header and mixer menus', async () => {
      renameTrack(trackId, 'Drums');
      setTrackFrozen(trackId, { assetId: 'frozen-asset' });
      const headers = mountHeaders();
      await headers.find('.track-name').trigger('dblclick');
      expect(headers.find('.track-name-input').exists()).toBe(false);
      await headers.find('.track-header').trigger('contextmenu', { clientX: 10, clientY: 10 });
      expect(useContextMenuState().items.find((item) => item.id === 'rename')?.disabled).toBe(true);
      expect(useContextMenuState().items.find((item) => item.id === 'regenerate')?.disabled).toBe(
        true,
      );

      closeContextMenu();
      const strip = mount(ChannelStrip, { props: { target: trackId }, shallow: true });
      await strip.find('.channel-strip').trigger('contextmenu', { clientX: 10, clientY: 10 });
      expect(useContextMenuState().items.find((item) => item.id === 'rename')?.disabled).toBe(true);
    });
  });
});
