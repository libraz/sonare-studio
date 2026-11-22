import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addAudioTrack, applyMixerSceneJson, clearHistory } from '@/project/commands';
import { MAX_STRIP_EQ_BANDS } from '@/project/mixer';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('applyMixerSceneJson strip mapping', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads pan law and pan mode by their scene file names', () => {
    const trackId = store.tracks[0].id;
    const laws = ['const3Db', 'const4.5Db', 'const6Db', 'linear0Db'];
    laws.forEach((law) => {
      applyMixerSceneJson(
        JSON.stringify({ strips: [{ id: `track-${trackId}`, panLaw: law }], buses: [] }),
      );
      expect(store.tracks[0].mixer?.panLaw ?? 'const3Db').toBe(law);
    });
    const modes = ['balance', 'stereoPan', 'dualPan'];
    modes.forEach((mode) => {
      applyMixerSceneJson(
        JSON.stringify({ strips: [{ id: `track-${trackId}`, panMode: mode }], buses: [] }),
      );
      expect(store.tracks[0].mixer?.panMode ?? 'balance').toBe(mode);
    });
  });

  it('keeps at most the engine EQ band count from a scene strip', () => {
    const trackId = store.tracks[0].id;
    const bands = Array.from({ length: MAX_STRIP_EQ_BANDS + 5 }, (_, index) => ({
      freqHz: 100 + index,
      gainDb: 1,
    }));
    applyMixerSceneJson(
      JSON.stringify({ strips: [{ id: `track-${trackId}`, eq: { bands } }], buses: [] }),
    );
    expect(store.tracks[0].mixer?.eq?.bands).toHaveLength(MAX_STRIP_EQ_BANDS);
  });

  it('resolves strips by track id without rescanning the strip list per track', () => {
    for (let i = 0; i < 7; i++) addAudioTrack({ name: `T${i}` });
    const strips = store.tracks
      .map((track) => ({ id: `track-${track.id}`, faderDb: -1 }))
      .reverse();
    const exec = vi.spyOn(RegExp.prototype, 'exec');

    applyMixerSceneJson(JSON.stringify({ strips, buses: [] }));

    const trackIdParses = exec.mock.calls.filter(
      ([text]) => typeof text === 'string' && text.startsWith('track-'),
    ).length;
    expect(trackIdParses).toBeLessThanOrEqual(strips.length);
    expect(store.tracks.every((track) => track.mixer?.gainDb === -1)).toBe(true);
  });
});

describe('applyMixerSceneJson insert params', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('keeps a closed-set insert param the scene names', () => {
    const store = useProjectStore();
    const trackId = store.tracks[0].id;
    applyMixerSceneJson(
      JSON.stringify({
        strips: [
          {
            id: `track-${trackId}`,
            inserts: [{ processor: 'dynamics.compressor', params: { detector: 'rms', ratio: 4 } }],
          },
        ],
        buses: [],
      }),
    );
    expect(store.tracks[0].mixer?.inserts[0]?.params).toEqual({ detector: 'rms', ratio: 4 });
  });
});
