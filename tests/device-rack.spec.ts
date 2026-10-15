import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AmpSimEditor from '@/components/devices/AmpSimEditor.vue';
import DeviceRack from '@/components/devices/DeviceRack.vue';
import { MAX_SOUNDFONT_FILE_BYTES } from '@/persistence/resource-limits';
import {
  addAudioTrack,
  addInsert,
  addTrack,
  clearHistory,
  renameTrack,
  setActiveTrack,
  setTrackInstrument,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { selectOption, selectValueText } from './helpers/select-menu';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const fontsMock = vi.hoisted(() => {
  const manifests = new Map<string, unknown[]>();
  return {
    manifests,
    listFonts: vi.fn(async () => [
      { id: 'fontaaaa00000001', name: 'GM Bank.sf2', byteLength: 1024 },
      { id: 'fontbbbb00000002', name: 'Strings.sf2', byteLength: 2048 },
    ]),
    loadFontMeta: vi.fn(async (id: string) => ({ id, name: 'GM Bank.sf2', byteLength: 1024 })),
    loadFont: vi.fn(async () => new Uint8Array([1, 2, 3])),
    getCachedSoundFontManifest: vi.fn(
      (id: string, bank: number) => manifests.get(`${id}:${bank}`) ?? null,
    ),
    cacheSoundFontManifest: vi.fn((id: string, bank: number, entries: unknown[]) => {
      manifests.set(
        `${id}:${bank}`,
        entries.map((entry) => ({ ...(entry as object) })),
      );
    }),
    saveFont: vi.fn(async (input: { name: string }, data: Uint8Array) => ({
      id: 'savedfont0000003',
      name: input.name,
      byteLength: data.length,
    })),
  };
});

vi.mock('@/project/fonts', () => fontsMock);

const gcMock = vi.hoisted(() => ({ deleteSoundFontIfUnreferenced: vi.fn(async () => false) }));

vi.mock('@/persistence/gc', () => gcMock);

const auditionMock = vi.hoisted(() => ({
  dispose: vi.fn(),
  play: vi.fn(async () => {}),
  stop: vi.fn(),
}));

vi.mock('@/ui/devices/audition', () => ({ createPatchAudition: vi.fn(() => auditionMock) }));

// Every picker mount owns an async SF2-manifest debounce. Unmount after each
// case so a previous case cannot call a freshly-reset mock while a later one
// is asserting its own request count.
enableAutoUnmount(afterEach);

/** Creates a manually-resolved promise for async race tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('DeviceRack.vue', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
    fontsMock.manifests.clear();
    Object.defineProperty(globalThis.navigator, 'requestMIDIAccess', {
      configurable: true,
      value: vi.fn(async () => ({
        outputs: new Map([['out-1', { id: 'out-1', name: 'Main Out' }]]),
        onstatechange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    await store.init();
    trackId = store.tracks[0].id;
  });

  it('shows an empty state when no track is active', async () => {
    store.activeTrackId = -1;
    const wrapper = mount(DeviceRack);
    expect(wrapper.find('.empty-state').exists()).toBe(true);
    expect(wrapper.find('.instrument-button').exists()).toBe(false);
  });

  it('captions the default instrument of the active MIDI track', () => {
    const wrapper = mount(DeviceRack);
    expect(wrapper.find('.rack-track').text()).toBe(store.tracks[0].name);
    expect(wrapper.find('.instrument-name').text()).toBe('acoustic-piano');
    expect(wrapper.find('.instrument-kind').text()).toBe('Preset');
    expect(wrapper.find('.instrument-source').text()).toBe('Built-in NativeSynth fallback preset');
  });

  it('auditions the active instrument directly from the rack', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-audition').trigger('click');
    await flushPromises();

    expect(auditionMock.play).toHaveBeenCalledWith(
      { kind: 'synth-preset', preset: 'acoustic-piano' },
      undefined,
      undefined,
      { normalize: true },
    );
    wrapper.unmount();
    expect(auditionMock.dispose).toHaveBeenCalledOnce();
  });

  it('hides the instrument slot for audio tracks but keeps the insert chain', () => {
    const audioId = addAudioTrack({ name: 'Mic' });
    setActiveTrack(audioId);
    const wrapper = mount(DeviceRack);
    expect(wrapper.find('.instrument-button').exists()).toBe(false);
    expect(wrapper.find('.add-insert').exists()).toBe(true);
  });

  it('keeps amp quick controls and strip automation beside the open amp editor', async () => {
    const audioId = addAudioTrack({ name: 'DI Guitar' });
    setActiveTrack(audioId);
    const positionPpq = () => 8;
    const positionSample = () => 1024;
    const scheduleAutomationWrite = vi.fn();
    const wrapper = mount(DeviceRack, {
      props: { positionPpq, positionSample, transportPlaying: true, scheduleAutomationWrite },
    });

    await wrapper.find('.guitar-amp-action').trigger('click');

    expect(wrapper.find('.amp-sim-editor').exists()).toBe(true);
    const ampEditor = wrapper.findComponent(AmpSimEditor);
    expect(ampEditor.props('positionPpq')).toBe(positionPpq);
    expect(ampEditor.props('positionSample')).toBe(positionSample);
    expect(ampEditor.props('isPlaying')).toBe(true);
    expect(ampEditor.props('scheduleAutomationWrite')).toBe(scheduleAutomationWrite);
    expect(wrapper.find('.rack-quick-controls').exists()).toBe(true);
    expect(
      wrapper.find('.rack-quick-controls [data-control="drive"]').attributes('aria-valuenow'),
    ).toBe('0.25');
    expect(wrapper.find('.rack-quick-controls [data-control="micDistanceCm"]').exists()).toBe(
      false,
    );
    expect(wrapper.find('.rack-quick-controls .strip-auto').exists()).toBe(true);
    expect(wrapper.findAll('.rack-quick-controls .strip-auto button')).toHaveLength(3);
  });

  it('opens the selected amp insert when a track contains multiple amp slots', async () => {
    const audioId = addAudioTrack({ name: 'DI Guitar' });
    addInsert(audioId, 'saturation.ampSim', { presetIndex: 0 });
    addInsert(audioId, 'saturation.ampSim', { presetIndex: 5 });
    setActiveTrack(audioId);
    const wrapper = mount(DeviceRack);

    // The shortcut opens the first amp, preserving the familiar guitar-amp action.
    await wrapper.find('.guitar-amp-action').trigger('click');
    expect(wrapper.find('input[aria-label="Drive"]').element).toHaveProperty('value', '0.25');

    await wrapper.findAll('.insert-name')[1].trigger('click');
    expect(wrapper.find('input[aria-label="Drive"]').element).toHaveProperty('value', '0.8');

    await wrapper.find('input[aria-label="Drive"]').setValue('0.9');
    const inserts = store.tracks.find((track) => track.id === audioId)?.mixer?.inserts;
    expect(inserts?.[0].params.drive).toBeUndefined();
    expect(inserts?.[1].params.drive).toBe(0.9);
  });

  it('opens the picker and commits a searched preset selection', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    expect(wrapper.find('.instrument-picker').exists()).toBe(true);

    await wrapper.find('.preset-search input').setValue('lead');
    const options = wrapper.findAll('.preset-option');
    expect(options.map((o) => o.find('.preset-name').text())).toEqual(['saw-lead', 'square-lead']);
    expect(wrapper.find('.preset-group-title').text()).toBe('Synths');

    await options[0].trigger('click');
    expect(store.tracks[0].instrument).toEqual({ kind: 'synth-preset', preset: 'saw-lead' });
    expect(wrapper.find('.instrument-picker').exists()).toBe(false);
    expect(wrapper.find('.instrument-name').text()).toBe('saw-lead');
  });

  it('selects a built-in GM program and reopens on its GM settings', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    await wrapper
      .findAll('.picker-tab')
      .find((tab) => tab.text() === 'GM')
      ?.trigger('click');
    await selectOption(wrapper, '.gm-field .select-menu', '025 · Nylon Guitar');
    await wrapper.find('.gm-use').trigger('click');

    expect(store.tracks[0].instrument).toEqual({
      kind: 'synth-preset',
      preset: 'acoustic-piano',
      useGmPrograms: true,
      gmBank: 0,
      gmProgram: 24,
    });
    expect(wrapper.find('.instrument-name').text()).toBe('GM · Nylon Guitar');

    await wrapper.find('.instrument-button').trigger('click');
    expect(wrapper.find('.picker-tab.active').text()).toBe('GM');
  });

  it('encodes a GS variation as bank select MSB and preserves it when reopened', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    await wrapper
      .findAll('.picker-tab')
      .find((tab) => tab.text() === 'GM')
      ?.trigger('click');
    expect(selectValueText(wrapper, '.gm-field .select-menu')).toBe('001 · Acoustic Grand Piano');
    await selectOption(wrapper, '.gm-field .select-menu', '025 · Nylon Guitar');
    await selectOption(wrapper, '.gm-field + .gm-field .select-menu', '1 · Ukulele');
    await wrapper.find('.gm-use').trigger('click');

    expect(store.tracks[0].instrument).toEqual({
      kind: 'synth-preset',
      preset: 'acoustic-piano',
      useGmPrograms: true,
      gmBank: 128,
      gmProgram: 24,
    });
    await wrapper.find('.instrument-button').trigger('click');
    expect(selectValueText(wrapper, '.gm-field + .gm-field .select-menu')).toBe('1 · Ukulele');
    expect(wrapper.find('.instrument-name').text()).toBe('GM · Ukulele');
  });

  it('shows drum kits for a percussion track even without an explicit override', async () => {
    renameTrack(trackId, 'Drums');
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    await wrapper
      .findAll('.picker-tab')
      .find((tab) => tab.text() === 'GM')
      ?.trigger('click');
    expect(selectValueText(wrapper, '.gm-field .select-menu')).toBe('001 · Standard Kit');
    await selectOption(wrapper, '.gm-field .select-menu', '009 · Room Kit');
    await wrapper.find('.gm-use').trigger('click');
    expect(store.tracks[0].instrument).toMatchObject({
      useGmPrograms: true,
      gmBank: 120 << 7,
      gmProgram: 8,
    });
    expect(wrapper.find('.instrument-name').text()).toBe('GM · Room Kit');
  });

  it('keeps an imported bank that has no voice for the current program', async () => {
    setTrackInstrument(trackId, {
      kind: 'synth-preset',
      preset: 'cello',
      useGmPrograms: true,
      gmBank: 129,
      gmProgram: 42,
    });
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    expect(selectValueText(wrapper, '.gm-field + .gm-field .select-menu')).toBe('1');
    await wrapper.find('.gm-use').trigger('click');
    expect(store.tracks[0].instrument).toMatchObject({ gmBank: 129, gmProgram: 42 });
  });

  it('opens the drum kit picker for a drum-kit preset on an empty track', async () => {
    setTrackInstrument(trackId, { kind: 'synth-preset', preset: 'drum-kit' });
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    await wrapper
      .findAll('.picker-tab')
      .find((tab) => tab.text() === 'GM')
      ?.trigger('click');
    expect(selectValueText(wrapper, '.gm-field .select-menu')).toBe('001 · Standard Kit');
    await wrapper.find('.gm-use').trigger('click');
    expect(store.tracks[0].instrument).toMatchObject({ gmBank: 120 << 7, gmProgram: 0 });
  });

  it('removes the instrument picker outside-click listener on unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const wrapper = mount(DeviceRack);

    await wrapper.find('.instrument-button').trigger('click');

    expect(add).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    wrapper.unmount();
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
  });

  it('lists physical-model synth presets from the runtime catalog', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');

    await wrapper.find('.preset-search input').setValue('pipe');
    let options = wrapper.findAll('.preset-option');
    expect(options.map((o) => o.find('.preset-name').text())).toEqual(['pipe-organ']);

    await wrapper.find('.preset-search input').setValue('bowed');
    options = wrapper.findAll('.preset-option');
    expect(options.map((o) => o.find('.preset-name').text())).toEqual(['bowed-string']);

    await options[0].trigger('click');
    expect(store.tracks[0].instrument).toEqual({ kind: 'synth-preset', preset: 'bowed-string' });
  });

  it('opens the instrument picker from a shell request', async () => {
    const wrapper = mount(DeviceRack, { props: { instrumentPickerRequest: 1 } });
    expect(wrapper.find('.instrument-picker').exists()).toBe(false);

    await wrapper.setProps({ instrumentPickerRequest: 2 });
    expect(wrapper.find('.instrument-picker').exists()).toBe(true);
  });

  it('keeps a stored SoundFont another project still references and says why', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    await wrapper
      .findAll('.picker-tab')
      .find((tab) => tab.text() === 'SF2')
      ?.trigger('click');
    await flushPromises();

    await wrapper.findAll('.font-remove')[0].trigger('click');
    await flushPromises();

    expect(gcMock.deleteSoundFontIfUnreferenced).toHaveBeenCalledWith(
      'fontaaaa00000001',
      expect.any(Function),
    );
    expect(wrapper.findAll('.font-option')).toHaveLength(2);
    expect(wrapper.text()).toContain('used by a track or a saved project');
  });

  it('lists stored fonts on the SF2 tab and commits a SoundFont selection', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    const sf2Tab = wrapper.findAll('.picker-tab').find((tab) => tab.text() === 'SF2');
    await sf2Tab?.trigger('click');
    await flushPromises();
    expect(fontsMock.listFonts).toHaveBeenCalled();

    const fonts = wrapper.findAll('.font-option');
    expect(fonts.map((f) => f.text())).toEqual(['GM Bank.sf2', 'Strings.sf2']);

    await fonts[1].trigger('click');
    await wrapper.find('.sf2-program').setValue('42');
    await wrapper.find('.use-sf2').trigger('click');
    expect(store.tracks[0].instrument).toEqual({
      kind: 'sf2',
      fontId: 'fontbbbb00000002',
      program: 42,
    });
  });

  it('commits a multi-timbral channel map with a drum kit and melodic bank/program', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    const sf2Tab = wrapper.findAll('.picker-tab').find((tab) => tab.text() === 'SF2');
    await sf2Tab?.trigger('click');
    await flushPromises();
    await wrapper.findAll('.font-option')[0].trigger('click');
    await wrapper.find('.sf2-bank').setValue('3');

    // Enable the multi-timbral channel map.
    await wrapper.find('.sf2-multitimbral-toggle input').setValue(true);

    // Enable the drum channel (channel 10) — its bank defaults to the GM2
    // drum-set bank (MSB 120, kit 0).
    const drumRow = wrapper.find('.sf2-channel-row.drum');
    await drumRow.find('.sf2-channel-toggle input').setValue(true);

    // Enable channel 1 (first row) and give it a melodic program.
    const firstRow = wrapper.findAll('.sf2-channel-row')[0];
    await firstRow.find('.sf2-channel-toggle input').setValue(true);
    await firstRow.find('.sf2-channel-bank').setValue('7');
    await firstRow.find('.sf2-channel-program').setValue('40');

    await wrapper.find('.use-sf2').trigger('click');
    expect(store.tracks[0].instrument).toEqual({
      kind: 'sf2',
      fontId: 'fontaaaa00000001',
      bank: 3,
      channelMap: [
        { channel: 0, bank: 7, program: 40 },
        { channel: 9, bank: 120 << 7, program: 0 },
      ],
    });
  });

  it('warns before applying an SF2 selection that would collide with another active font', async () => {
    const secondTrackId = addTrack({ name: 'Pad' });
    setTrackInstrument(secondTrackId, { kind: 'sf2', fontId: 'fontaaaa00000001' });
    setActiveTrack(trackId);
    const wrapper = mount(DeviceRack);

    await wrapper.find('.instrument-button').trigger('click');
    const sf2Tab = wrapper.findAll('.picker-tab').find((tab) => tab.text() === 'SF2');
    await sf2Tab?.trigger('click');
    await flushPromises();

    await wrapper.findAll('.font-option')[1].trigger('click');

    expect(wrapper.find('.sf2-slot-warning').text()).toBe(
      'This project uses 2 SoundFonts, but playback has one global SF2 slot and uses the font of the last SF2 track: GM Bank.sf2. Export renders each SF2 track with its own font, so it can sound different.',
    );
    expect(store.tracks[0].instrument).not.toEqual({ kind: 'sf2', fontId: 'fontbbbb00000002' });
  });

  it('auditions a SoundFont program selection before committing it to the track', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    const sf2Tab = wrapper.findAll('.picker-tab').find((tab) => tab.text() === 'SF2');
    await sf2Tab?.trigger('click');
    await flushPromises();

    await wrapper.findAll('.font-option')[0].trigger('click');
    await wrapper.findAll('.sf2-program-option')[2].trigger('click');
    await flushPromises();

    expect(auditionMock.play).toHaveBeenCalledWith(
      { kind: 'sf2', fontId: 'fontaaaa00000001', program: 2 },
      undefined,
      undefined,
      { normalize: true },
    );
    expect(store.tracks[0].instrument).toBeUndefined();
  });

  it('checks the selected SF2 program against the SoundFont manifest', async () => {
    vi.useFakeTimers();
    let wrapper: ReturnType<typeof mount> | undefined;
    try {
      wrapper = mount(DeviceRack);
      await wrapper.find('.instrument-button').trigger('click');
      const sf2Tab = wrapper.findAll('.picker-tab').find((tab) => tab.text() === 'SF2');
      await sf2Tab?.trigger('click');
      await flushPromises();

      await wrapper.findAll('.font-option')[0].trigger('click');
      await wrapper.find('.sf2-bank').setValue('1');
      await wrapper.find('.sf2-program').setValue('24');
      await vi.advanceTimersByTimeAsync(75);
      await flushPromises();
      await flushPromises();

      expect(fontsMock.loadFont).toHaveBeenCalledWith('fontaaaa00000001');
      expect(wrapper.find('.sf2-manifest-status').text()).toBe('SF2 preset: SF2 1:24 (1:24)');
    } finally {
      wrapper?.unmount();
      vi.useRealTimers();
    }
  });

  it('lists SoundFont manifest presets and commits the selected bank/program', async () => {
    vi.useFakeTimers();
    let wrapper: ReturnType<typeof mount> | undefined;
    try {
      wrapper = mount(DeviceRack);
      await wrapper.find('.instrument-button').trigger('click');
      const sf2Tab = wrapper.findAll('.picker-tab').find((tab) => tab.text() === 'SF2');
      await sf2Tab?.trigger('click');
      await flushPromises();

      await wrapper.findAll('.font-option')[0].trigger('click');
      await wrapper.find('.sf2-bank').setValue('1');
      await vi.advanceTimersByTimeAsync(75);
      await flushPromises();
      await flushPromises();

      const manifestOptions = wrapper.findAll('.sf2-manifest-option');
      expect(manifestOptions).toHaveLength(128);
      const preset = manifestOptions.find((option) => option.text().includes('SF2 1:42'));
      expect(preset).toBeTruthy();

      await preset?.trigger('click');
      await wrapper.find('.use-sf2').trigger('click');

      expect(store.tracks[0].instrument).toEqual({
        kind: 'sf2',
        fontId: 'fontaaaa00000001',
        bank: 1,
        program: 42,
      });
    } finally {
      wrapper?.unmount();
      vi.useRealTimers();
    }
  });

  it('debounces rapid program changes and reuses the resolved bank manifest', async () => {
    vi.useFakeTimers();
    let wrapper: ReturnType<typeof mount> | undefined;
    try {
      wrapper = mount(DeviceRack);
      await wrapper.find('.instrument-button').trigger('click');
      const sf2Tab = wrapper.findAll('.picker-tab').find((tab) => tab.text() === 'SF2');
      await sf2Tab?.trigger('click');
      await flushPromises();
      await wrapper.findAll('.font-option')[0].trigger('click');
      await wrapper.find('.sf2-program').setValue('20');
      await wrapper.find('.sf2-program').setValue('21');
      await wrapper.find('.sf2-program').setValue('22');

      await vi.advanceTimersByTimeAsync(75);
      await flushPromises();
      expect(fontsMock.loadFont).toHaveBeenCalledTimes(1);

      await wrapper.find('.sf2-program').setValue('23');
      await flushPromises();
      expect(fontsMock.loadFont).toHaveBeenCalledTimes(1);
    } finally {
      wrapper?.unmount();
      vi.useRealTimers();
    }
  });

  it('commits the SF2 master gain and voice cap from the picker', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    const sf2Tab = wrapper.findAll('.picker-tab').find((tab) => tab.text() === 'SF2');
    await sf2Tab?.trigger('click');
    await flushPromises();

    await wrapper.findAll('.font-option')[0].trigger('click');
    await wrapper.find('.sf2-gain').setValue('1.5');
    await wrapper.find('.sf2-polyphony').setValue('24');
    await wrapper.find('.use-sf2').trigger('click');
    expect(store.tracks[0].instrument).toEqual({
      kind: 'sf2',
      fontId: 'fontaaaa00000001',
      gain: 1.5,
      polyphony: 24,
    });
  });

  it('commits the modelled-instrument preference from the picker', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    const sf2Tab = wrapper.findAll('.picker-tab').find((tab) => tab.text() === 'SF2');
    await sf2Tab?.trigger('click');
    await flushPromises();

    await wrapper.findAll('.font-option')[0].trigger('click');
    await wrapper.find('.sf2-prefer-model').setValue(true);
    await wrapper.find('.use-sf2').trigger('click');

    // It rides on the instrument, not on an app preference, so the choice
    // travels with the project and keys the prerender cache.
    expect(store.tracks[0].instrument).toEqual({
      kind: 'sf2',
      fontId: 'fontaaaa00000001',
      preferModelForModeledFamilies: true,
    });
  });

  it('commits and restores the GS EFX realisation picker value', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    const sf2Tab = wrapper.findAll('.picker-tab').find((tab) => tab.text() === 'SF2');
    await sf2Tab?.trigger('click');
    await flushPromises();

    await wrapper.findAll('.font-option')[0].trigger('click');
    expect((wrapper.find('.sf2-efx-realization').element as HTMLSelectElement).value).toBe(
      'modern',
    );
    await wrapper.find('.sf2-efx-realization').setValue('classic');
    await wrapper.find('.use-sf2').trigger('click');
    expect(store.tracks[0].instrument).toEqual({
      kind: 'sf2',
      fontId: 'fontaaaa00000001',
      gsEfxRealization: 'classic',
    });

    await wrapper.find('.instrument-button').trigger('click');
    expect((wrapper.find('.sf2-efx-realization').element as HTMLSelectElement).value).toBe(
      'classic',
    );
    await wrapper.find('.sf2-efx-realization').setValue('modern');
    await wrapper.find('.use-sf2').trigger('click');
    expect(store.tracks[0].instrument).toEqual({
      kind: 'sf2',
      fontId: 'fontaaaa00000001',
    });
  });

  it('imports a .sf2 file into the font store and selects it', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    const sf2Tab = wrapper.findAll('.picker-tab').find((tab) => tab.text() === 'SF2');
    await sf2Tab?.trigger('click');
    await flushPromises();

    const input = wrapper.find('.load-sf2-input');
    const file = new File(
      [new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x73, 0x66, 0x62, 0x6b])],
      'Custom.sf2',
    );
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    await flushPromises();

    expect(fontsMock.saveFont).toHaveBeenCalledWith({ name: 'Custom.sf2' }, expect.any(Uint8Array));
    // The freshly stored font becomes the picker selection.
    await wrapper.find('.use-sf2').trigger('click');
    expect(store.tracks[0].instrument).toEqual({ kind: 'sf2', fontId: 'savedfont0000003' });
  });

  it('rejects an oversized SF2 before allocating its bytes', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    const sf2Tab = wrapper.findAll('.picker-tab').find((tab) => tab.text() === 'SF2');
    await sf2Tab?.trigger('click');
    await flushPromises();

    const file = new File([new Uint8Array(1)], 'Too-large.sf2');
    const arrayBuffer = vi.fn(file.arrayBuffer.bind(file));
    Object.defineProperty(file, 'size', {
      configurable: true,
      value: MAX_SOUNDFONT_FILE_BYTES + 1,
    });
    Object.defineProperty(file, 'arrayBuffer', { configurable: true, value: arrayBuffer });
    const input = wrapper.find('.load-sf2-input');
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    await flushPromises();

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(fontsMock.saveFont).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('File "Too-large.sf2" is too large');
  });

  it('applies a project External MIDI default to every MIDI track while leaving audio tracks alone', async () => {
    const secondMidiId = addTrack({ name: 'Pad' });
    const audioId = addAudioTrack({ name: 'Mic' });
    setActiveTrack(trackId);
    const wrapper = mount(DeviceRack);

    await wrapper.find('.instrument-button').trigger('click');
    const externalTab = wrapper
      .findAll('.picker-tab')
      .find((tab) => tab.text() === 'External MIDI');
    await externalTab?.trigger('click');
    await flushPromises();

    await selectOption(wrapper, '.external-field .select-menu', 'Main Out');
    await wrapper.find('.external-channel').setValue('4');
    await wrapper.find('.external-clock input').setValue(true);
    await wrapper.find('.use-project-external-all').trigger('click');

    const expected = {
      kind: 'external-midi',
      outputPortId: 'out-1',
      channel: 3,
      sendClock: true,
    };
    expect(store.projectExternalMidi).toEqual(expected);
    expect(store.tracks.find((track) => track.id === trackId)?.externalMidiMode).toBe('project');
    expect(store.tracks.find((track) => track.id === secondMidiId)?.externalMidiMode).toBe(
      'project',
    );
    expect(store.tracks.find((track) => track.id === audioId)?.instrument).toBeUndefined();
    expect(store.tracks.find((track) => track.id === audioId)?.externalMidiMode).toBeUndefined();
  });

  it('summarizes the patch tab and opens the patch editor', async () => {
    setTrackInstrument(trackId, {
      kind: 'synth-patch',
      patch: { preset: 'saw-lead', cutoffHz: 500 },
    });
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    // A synth-patch instrument lands on the Patch tab directly.
    expect(wrapper.find('.patch-summary').text()).toBe('saw-lead · 1 edit');
    await wrapper.find('.edit-patch').trigger('click');
    expect(wrapper.find('[aria-label="Patch editor"]').exists()).toBe(true);
  });

  it('manages the insert chain: add, select, bypass and remove', async () => {
    const wrapper = mount(DeviceRack);
    expect(wrapper.find('.chain-empty').exists()).toBe(true);

    await selectOption(wrapper, '.add-insert', 'Compressor (dynamics)');
    expect(store.tracks[0].mixer?.inserts).toHaveLength(1);
    const row = wrapper.find('.insert-row');
    expect(row.find('.insert-name').text()).toContain('Compressor');
    // A freshly added insert is selected for the quick controls.
    expect(row.classes()).toContain('selected');
    expect(wrapper.find('[data-control="thresholdDb"]').exists()).toBe(true);

    await row.find('.insert-power').trigger('click');
    expect(store.tracks[0].mixer?.inserts[0].enabled).toBe(false);

    await row.find('.insert-remove').trigger('click');
    expect(store.tracks[0].mixer?.inserts).toHaveLength(0);
    // Selection falls back to the instrument quick controls.
    expect(wrapper.find('[data-control="cutoffHz"]').exists()).toBe(true);
  });

  it('uses the shared realtime insert catalog for the add-insert picker', async () => {
    const wrapper = mount(DeviceRack);

    await selectOption(wrapper, '.add-insert', 'Tilt (eq)');

    expect(store.tracks[0].mixer?.inserts[0].processor).toBe('eq.tilt');
  });

  it('can add modulation processors when the runtime insert catalog exposes them', async () => {
    const wrapper = mount(DeviceRack);

    await selectOption(wrapper, '.add-insert', 'Rotary (modulation)');

    expect(store.tracks[0].mixer?.inserts[0].processor).toBe('modulation.rotary');
    expect(wrapper.find('[data-control="speed"]').exists()).toBe(true);
  });

  it('resolves the stored font name for the sf2 caption', async () => {
    setTrackInstrument(trackId, { kind: 'sf2', fontId: 'fontaaaa00000001', program: 5 });
    const wrapper = mount(DeviceRack);
    await flushPromises();
    expect(fontsMock.loadFontMeta).toHaveBeenCalledWith('fontaaaa00000001');
    expect(wrapper.find('.instrument-name').text()).toBe('GM Bank.sf2 · 0:5');
  });

  it('does not apply a stored font name after unmount', async () => {
    const pending = deferred<{ id: string; name: string; byteLength: number }>();
    fontsMock.loadFontMeta.mockReturnValueOnce(pending.promise);
    setTrackInstrument(trackId, { kind: 'sf2', fontId: 'fontaaaa00000001', program: 5 });
    const wrapper = mount(DeviceRack);

    wrapper.unmount();
    pending.resolve({ id: 'fontaaaa00000001', name: 'Late Bank.sf2', byteLength: 1024 });
    await flushPromises();

    expect(fontsMock.loadFontMeta).toHaveBeenCalledWith('fontaaaa00000001');
    expect(wrapper.text()).not.toContain('Late Bank.sf2');
  });
});
