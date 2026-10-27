import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { createMixerSync } from '@/engine/mixer-sync';
import {
  addAudioTrack,
  addBouncedClip,
  addGroupTrack,
  addTrack,
  clearHistory,
} from '@/project/commands';
import { assertCanAddTracks, createDefaultStrip, MAX_TRACK_LANES } from '@/project/mixer';
import {
  loadProjectDocument,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

function track(id: number): EditorTrack {
  return {
    id,
    name: `Track ${id}`,
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: id,
  };
}

describe('track lane cap', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  function fillToCap(): void {
    while (store.tracks.length < MAX_TRACK_LANES) addTrack();
  }

  it('refuses every track-creating command at the cap and leaves the project unchanged', () => {
    fillToCap();
    expect(store.tracks).toHaveLength(MAX_TRACK_LANES);
    expect(() => addTrack()).toThrow(/Track limit reached/);
    expect(() => addAudioTrack()).toThrow(/Track limit reached/);
    expect(() => addGroupTrack()).toThrow(/Track limit reached/);
    expect(() =>
      addBouncedClip({ name: 'Bounce', assetId: 'asset', startPpq: 0, lengthPpq: 480 }),
    ).toThrow(/Track limit reached/);
    expect(store.tracks).toHaveLength(MAX_TRACK_LANES);
  });

  it('names the requested count and the limit', () => {
    expect(() => assertCanAddTracks(30, 5)).toThrow(
      `35 tracks requested, at most ${MAX_TRACK_LANES}`,
    );
    expect(() => assertCanAddTracks(30, 2)).not.toThrow();
  });

  it('still opens a document saved with more tracks than lanes', async () => {
    const doc = JSON.parse(JSON.stringify(serializeProject())) as ProjectDocument;
    doc.tracks = Array.from({ length: MAX_TRACK_LANES + 1 }, () => structuredClone(doc.tracks[0]));
    await loadProjectDocument(doc);
    expect(store.tracks).toHaveLength(MAX_TRACK_LANES + 1);
  });
});

describe('mixer sync over the lane cap', () => {
  it('declares the first lanes, keeps syncing them and reports the overflow', () => {
    const declared: number[] = [];
    const engine = {
      setTrackLanes: vi.fn((lanes: number[]) => {
        if (lanes.length > MAX_TRACK_LANES) throw new RangeError('too many lanes');
        declared.splice(0, declared.length, ...lanes);
      }),
      setStripGain: vi.fn(() => true),
      setStripPan: vi.fn(() => true),
      setSoloMute: vi.fn(() => true),
      setTrackStripChannelDelaySamples: vi.fn(),
      setTrackStripPanLaw: vi.fn(),
      setTrackStripPanMode: vi.fn(),
      setTrackStripDualPan: vi.fn(),
    };
    const handle = { engine, ctx: { state: 'running' } } as unknown as EngineHandle;
    const sync = createMixerSync(handle);
    const tracks = Array.from({ length: MAX_TRACK_LANES + 3 }, (_, index) => track(index + 1));
    expect(() => sync.sync(tracks, createDefaultStrip())).not.toThrow();
    expect(declared).toEqual(tracks.slice(0, MAX_TRACK_LANES).map((entry) => entry.id));
    expect(sync.laneOverflowCount?.()).toBe(3);

    engine.setStripGain.mockClear();
    tracks[0] = { ...tracks[0], volume: 0.5 };
    expect(() => sync.sync(tracks, createDefaultStrip())).not.toThrow();
    expect(engine.setStripGain).toHaveBeenCalledWith(1, expect.any(Number));
    expect(engine.setStripGain).not.toHaveBeenCalledWith(MAX_TRACK_LANES + 1, expect.any(Number));

    sync.sync(tracks.slice(0, MAX_TRACK_LANES), createDefaultStrip());
    expect(sync.laneOverflowCount?.()).toBe(0);
  });
});
