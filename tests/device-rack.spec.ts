import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceRack from '@/components/devices/DeviceRack.vue';
import {
  addAudioTrack,
  addTrack,
  clearHistory,
  setActiveTrack,
  setTrackInstrument,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { selectOption } from './helpers/select-menu';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const fontsMock = vi.hoisted(() => ({
  listFonts: vi.fn(async () => [
    { id: 'fontaaaa00000001', name: 'GM Bank.sf2', byteLength: 1024 },
    { id: 'fontbbbb00000002', name: 'Strings.sf2', byteLength: 2048 },
  ]),
  loadFontMeta: vi.fn(async (id: string) => ({ id, name: 'GM Bank.sf2', byteLength: 1024 })),
  loadFont: vi.fn(async () => new Uint8Array([1, 2, 3])),
  saveFont: vi.fn(async (input: { name: string }, data: Uint8Array) => ({
    id: 'savedfont0000003',
    name: input.name,
    byteLength: data.length,
  })),
}));

vi.mock('@/project/fonts', () => fontsMock);

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
    expect(wrapper.find('.instrument-name').text()).toBe('e-piano');
    expect(wrapper.find('.instrument-kind').text()).toBe('Preset');
    expect(wrapper.find('.instrument-source').text()).toBe('Built-in NativeSynth fallback preset');
  });

  it('hides the instrument slot for audio tracks but keeps the insert chain', () => {
    const audioId = addAudioTrack({ name: 'Mic' });
    setActiveTrack(audioId);
    const wrapper = mount(DeviceRack);
    expect(wrapper.find('.instrument-button').exists()).toBe(false);
    expect(wrapper.find('.add-insert').exists()).toBe(true);
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

  it('removes the instrument picker outside-click listener on unmount', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
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
      'This project uses 2 SoundFonts, but playback and export share one global SF2 slot. The last SF2 track wins: GM Bank.sf2.',
    );
    expect(store.tracks[0].instrument).not.toEqual({ kind: 'sf2', fontId: 'fontbbbb00000002' });
  });

  it('checks the selected SF2 program against the SoundFont manifest', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    const sf2Tab = wrapper.findAll('.picker-tab').find((tab) => tab.text() === 'SF2');
    await sf2Tab?.trigger('click');
    await flushPromises();

    await wrapper.findAll('.font-option')[0].trigger('click');
    await wrapper.find('.sf2-bank').setValue('1');
    await wrapper.find('.sf2-program').setValue('24');
    await flushPromises();
    await flushPromises();

    expect(fontsMock.loadFont).toHaveBeenCalledWith('fontaaaa00000001');
    expect(wrapper.find('.sf2-manifest-status').text()).toBe('SF2 preset: SF2 1:24 (1:24)');
  });

  it('lists SoundFont manifest presets and commits the selected bank/program', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    const sf2Tab = wrapper.findAll('.picker-tab').find((tab) => tab.text() === 'SF2');
    await sf2Tab?.trigger('click');
    await flushPromises();

    await wrapper.findAll('.font-option')[0].trigger('click');
    await wrapper.find('.sf2-bank').setValue('1');
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

  it('imports a .sf2 file into the font store and selects it', async () => {
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    const sf2Tab = wrapper.findAll('.picker-tab').find((tab) => tab.text() === 'SF2');
    await sf2Tab?.trigger('click');
    await flushPromises();

    const input = wrapper.find('.load-sf2-input');
    const file = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], 'Custom.sf2');
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    await flushPromises();

    expect(fontsMock.saveFont).toHaveBeenCalledWith({ name: 'Custom.sf2' }, expect.any(Uint8Array));
    // The freshly stored font becomes the picker selection.
    await wrapper.find('.use-sf2').trigger('click');
    expect(store.tracks[0].instrument).toEqual({ kind: 'sf2', fontId: 'savedfont0000003' });
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
