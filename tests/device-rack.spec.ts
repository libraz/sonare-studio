import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceRack from '@/components/devices/DeviceRack.vue';
import {
  addAudioTrack,
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

describe('DeviceRack.vue', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
    await store.init();
    trackId = store.tracks[0].id;
  });

  it('shows an empty state when no track is active', async () => {
    store.activeTrackId = -1;
    const wrapper = mount(DeviceRack);
    expect(wrapper.find('.rack-empty').exists()).toBe(true);
    expect(wrapper.find('.instrument-button').exists()).toBe(false);
  });

  it('captions the default instrument of the active MIDI track', () => {
    const wrapper = mount(DeviceRack);
    expect(wrapper.find('.rack-track').text()).toBe(store.tracks[0].name);
    expect(wrapper.find('.instrument-name').text()).toBe('e-piano');
    expect(wrapper.find('.instrument-kind').text()).toBe('Preset');
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
    expect(options.map((o) => o.text())).toEqual(['saw-lead', 'square-lead']);

    await options[0].trigger('click');
    expect(store.tracks[0].instrument).toEqual({ kind: 'synth-preset', preset: 'saw-lead' });
    expect(wrapper.find('.instrument-picker').exists()).toBe(false);
    expect(wrapper.find('.instrument-name').text()).toBe('saw-lead');
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

  it('resolves the stored font name for the sf2 caption', async () => {
    setTrackInstrument(trackId, { kind: 'sf2', fontId: 'fontaaaa00000001', program: 5 });
    const wrapper = mount(DeviceRack);
    await flushPromises();
    expect(fontsMock.loadFontMeta).toHaveBeenCalledWith('fontaaaa00000001');
    expect(wrapper.find('.instrument-name').text()).toBe('GM Bank.sf2 · 0:5');
  });
});
