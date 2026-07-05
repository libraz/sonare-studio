import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioAssetMeta, LoadedAudioAsset } from '@/persistence/assets';
import {
  addAudioClip,
  addAudioTrack,
  clearHistory,
  detectChordsFromAudioClip,
  detectSectionsFromAudioClip,
  extractMelodyFromAudioClip,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';

const wasmModule = vi.hoisted(() => ({
  current: undefined as undefined | Record<string, unknown>,
}));

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  wasmModule.current = fakeModule as unknown as Record<string, unknown>;
  return { ensureWasm: async () => wasmModule.current };
});

const assetStore = vi.hoisted(() => ({
  loadAssetMeta: vi.fn<(id: string) => Promise<AudioAssetMeta>>(),
  loadAsset: vi.fn<(id: string) => Promise<LoadedAudioAsset>>(),
  audioAssetUri: (assetId: string) => `asset:${assetId}`,
}));
vi.mock('@/persistence/assets', () => assetStore);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function loadedAsset(id = 'asset-1'): LoadedAudioAsset {
  return {
    meta: {
      id,
      name: id,
      sampleRate: 48000,
      numChannels: 1,
      numFrames: 96000,
    },
    channels: [new Float32Array(96000).fill(0.5)],
  };
}

describe('audio analysis command stale clip guards', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
    assetStore.loadAssetMeta.mockImplementation(async (id) => ({
      id,
      name: id,
      sampleRate: 48000,
      numChannels: 1,
      numFrames: 96000,
    }));
    await store.init();
  });

  async function addSourceClip(): Promise<number> {
    const trackId = addAudioTrack({ name: 'Audio' });
    return addAudioClip({ trackId, assetId: 'asset-1', lengthPpq: 4, name: 'Source' });
  }

  it('does not create a melody clip when the source clip changes while loading', async () => {
    const pending = deferred<LoadedAudioAsset>();
    assetStore.loadAsset.mockReturnValueOnce(pending.promise);
    Object.assign(wasmModule.current ?? {}, {
      analyzeMelody: () => ({
        points: [
          { time: 0, frequency: 440, confidence: 1 },
          { time: 0.5, frequency: 0, confidence: 0 },
        ],
      }),
    });
    const clipId = await addSourceClip();
    const clipCount = store.clips.length;
    const trackCount = store.tracks.length;

    const extraction = extractMelodyFromAudioClip(clipId);
    store.clips = store.clips.map((clip) =>
      clip.id === clipId ? { ...clip, assetId: 'asset-2' } : clip,
    );
    pending.resolve(loadedAsset('asset-1'));
    await expect(extraction).resolves.toBe(-1);

    expect(store.clips).toHaveLength(clipCount);
    expect(store.tracks).toHaveLength(trackCount);
  });

  it('does not merge audio chords when the source clip changes while loading', async () => {
    const pending = deferred<LoadedAudioAsset>();
    assetStore.loadAsset.mockReturnValueOnce(pending.promise);
    Object.assign(wasmModule.current ?? {}, {
      detectChords: () => ({ chords: [{ root: 0, bass: 0, quality: 0, start: 0, end: 1 }] }),
    });
    const clipId = await addSourceClip();

    const detection = detectChordsFromAudioClip(clipId);
    store.clips = store.clips.map((clip) =>
      clip.id === clipId ? { ...clip, assetId: 'asset-2' } : clip,
    );
    pending.resolve(loadedAsset('asset-1'));
    await expect(detection).resolves.toBe(0);

    expect(store.chords).toEqual([]);
  });

  it('does not merge audio sections when the source clip changes while loading', async () => {
    const pending = deferred<LoadedAudioAsset>();
    assetStore.loadAsset.mockReturnValueOnce(pending.promise);
    Object.assign(wasmModule.current ?? {}, {
      analyzeSections: () => [{ type: 0, start: 0, end: 1 }],
    });
    const clipId = await addSourceClip();

    const detection = detectSectionsFromAudioClip(clipId);
    store.clips = store.clips.map((clip) =>
      clip.id === clipId ? { ...clip, assetId: 'asset-2' } : clip,
    );
    pending.resolve(loadedAsset('asset-1'));
    await expect(detection).resolves.toBe(0);

    expect(store.sections).toEqual([]);
  });
});
