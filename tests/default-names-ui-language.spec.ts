import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppSettings } from '@/composables/useAppSettings';
import {
  addAudioClip,
  addAudioTrack,
  addMidiClip,
  addMixerBus,
  addTrack,
  addVcaGroup,
  clearHistory,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('default names in the UI language', () => {
  const settings = useAppSettings();
  const previous = settings.settings.language;
  let store: ReturnType<typeof useProjectStore>;

  async function openProject(): Promise<void> {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  }

  beforeEach(() => settings.set('language', 'ja'));
  afterEach(() => settings.set('language', previous));

  it('names the initial track and project in Japanese', async () => {
    await openProject();
    expect(store.projectName).toBe('無題');
    expect(store.tracks.map((t) => t.name)).toEqual(['ピアノ']);
  });

  it('names new tracks, clips, VCA groups and buses in Japanese', async () => {
    await openProject();
    const trackId = addTrack();
    expect(store.tracks.find((t) => t.id === trackId)?.name).toBe('トラック 2');

    const clipId = addMidiClip({ trackId, lengthPpq: 4 });
    expect(store.clips.find((c) => c.id === clipId)?.name).toBe(`クリップ ${clipId}`);

    const audioTrackId = addAudioTrack();
    const audioClipId = await addAudioClip({ trackId: audioTrackId, assetId: 'a', lengthPpq: 4 });
    expect(store.clips.find((c) => c.id === audioClipId)?.name).toBe(`クリップ ${audioClipId}`);

    addVcaGroup();
    expect((store.mixer.vcaGroups ?? []).map((g) => g.name)).toEqual(['VCA 1']);

    const busId = addMixerBus();
    expect(busId).toBe('bus-1');
    expect(store.mixer.buses.map((b) => b.name)).toEqual(['バス 1']);
  });

  it('names new tracks, clips, VCA groups and buses in English', async () => {
    settings.set('language', 'en');
    await openProject();
    const trackId = addTrack();
    expect(store.tracks.find((t) => t.id === trackId)?.name).toBe('Track 2');
    const clipId = addMidiClip({ trackId, lengthPpq: 4 });
    expect(store.clips.find((c) => c.id === clipId)?.name).toBe(`Clip ${clipId}`);
    addVcaGroup();
    expect((store.mixer.vcaGroups ?? []).map((g) => g.name)).toEqual(['VCA 1']);
    addMixerBus();
    expect(store.mixer.buses.map((b) => b.name)).toEqual(['Bus 1']);
  });

  it('keeps stored names after a language switch and names later ones in the new language', async () => {
    await openProject();
    const trackId = addTrack();
    const clipId = addMidiClip({ trackId, lengthPpq: 4 });
    addMixerBus();

    settings.set('language', 'en');
    store.refresh();
    expect(store.tracks.find((t) => t.id === trackId)?.name).toBe('トラック 2');
    expect(store.clips.find((c) => c.id === clipId)?.name).toBe(`クリップ ${clipId}`);
    expect(store.mixer.buses.map((b) => b.name)).toEqual(['バス 1']);

    const laterTrackId = addTrack();
    expect(store.tracks.find((t) => t.id === laterTrackId)?.name).toBe('Track 3');
    addMixerBus();
    expect(store.mixer.buses.map((b) => b.name)).toEqual(['バス 1', 'Bus 2']);
  });

  it('throws when no namer is registered in the execution context', async () => {
    vi.resetModules();
    const fresh = await import('@/project/default-names');
    expect(() => fresh.defaultName('track', { number: 1 })).toThrow();
    expect(() => fresh.defaultNameTable()).toThrow();
  });
});
