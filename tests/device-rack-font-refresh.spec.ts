import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceRack from '@/components/devices/DeviceRack.vue';
import { clearHistory } from '@/project/commands';
import type { SoundFontMeta } from '@/project/fonts';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const fontsMock = vi.hoisted(() => ({
  listFonts: vi.fn<() => Promise<SoundFontMeta[]>>(),
  loadFontMeta: vi.fn(async (id: string) => ({ id, name: 'GM Bank.sf2', byteLength: 1024 })),
  loadFont: vi.fn(async () => new Uint8Array([1, 2, 3])),
  getCachedSoundFontManifest: vi.fn(() => null),
  cacheSoundFontManifest: vi.fn(),
  saveFont: vi.fn(),
}));

vi.mock('@/project/fonts', () => fontsMock);
vi.mock('@/persistence/gc', () => ({ deleteSoundFontIfUnreferenced: vi.fn(async () => false) }));
vi.mock('@/ui/devices/audition', () => ({
  createPatchAudition: vi.fn(() => ({
    dispose: vi.fn(),
    play: vi.fn(async () => {}),
    stop: vi.fn(),
  })),
}));

enableAutoUnmount(afterEach);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const OLD: SoundFontMeta[] = [{ id: 'fontaaaa00000001', name: 'Old.sf2', byteLength: 1 }];
const NEW: SoundFontMeta[] = [{ id: 'fontbbbb00000002', name: 'New.sf2', byteLength: 2 }];

describe('DeviceRack SoundFont list refresh', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
    await store.init();
  });

  async function openSf2Twice(first: Promise<SoundFontMeta[]>, second: Promise<SoundFontMeta[]>) {
    fontsMock.listFonts.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const wrapper = mount(DeviceRack);
    await wrapper.find('.instrument-button').trigger('click');
    const tab = (label: string) => wrapper.findAll('.picker-tab').find((t) => t.text() === label);
    await tab('SF2')?.trigger('click');
    await tab('Presets')?.trigger('click');
    await tab('SF2')?.trigger('click');
    expect(fontsMock.listFonts).toHaveBeenCalledTimes(2);
    return wrapper;
  }

  it('keeps the newest list when an older request resolves last', async () => {
    const first = deferred<SoundFontMeta[]>();
    const second = deferred<SoundFontMeta[]>();
    const wrapper = await openSf2Twice(first.promise, second.promise);
    second.resolve(NEW);
    await flushPromises();
    first.resolve(OLD);
    await flushPromises();
    expect(wrapper.findAll('.font-option').map((f) => f.text())).toEqual(['New.sf2']);
  });

  it('stays loading until the newest request settles', async () => {
    const first = deferred<SoundFontMeta[]>();
    const second = deferred<SoundFontMeta[]>();
    const wrapper = await openSf2Twice(first.promise, second.promise);
    first.resolve(OLD);
    await flushPromises();
    expect(wrapper.find('.fonts-loading').exists()).toBe(true);
    second.resolve(NEW);
    await flushPromises();
    expect(wrapper.find('.fonts-loading').exists()).toBe(false);
    expect(wrapper.findAll('.font-option').map((f) => f.text())).toEqual(['New.sf2']);
  });
});
