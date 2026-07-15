import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useProjectAudioAssets } from '@/composables/useProjectAudioAssets';
import type { AudioAssetMeta } from '@/persistence/assets';
import {
  addAudioClip,
  addAudioTrack,
  clearHistory,
  deleteClip,
  setTempoSegments,
  undo,
} from '@/project/commands';
import { getProject, useProjectStore } from '@/project/store';

const assetStore = vi.hoisted(() => ({
  audioAssetUri: (assetId: string) => `asset:${assetId}`,
  loadAssetMeta: vi.fn<(id: string) => Promise<AudioAssetMeta>>(),
  loadAsset: vi.fn(),
}));
vi.mock('@/persistence/assets', () => assetStore);

const audioImport = vi.hoisted(() => ({
  analyzeAudioTags: vi.fn(),
  decodeAndIngest: vi.fn(),
  resolveAudioAnalysis: vi.fn(),
}));
vi.mock('@/project/audio-import', () => audioImport);

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

/** Creates a manually-resolved promise for async race tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useProjectAudioAssets', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
    await store.init();
  });

  it('places imported assets with tempo-map duration at the playhead', async () => {
    setTempoSegments([
      { startPpq: 0, bpm: 120 },
      { startPpq: 4, bpm: 60 },
    ]);
    assetStore.loadAssetMeta.mockResolvedValue({
      id: 'asset-1',
      name: 'Two seconds',
      sampleRate: 48000,
      numChannels: 1,
      numFrames: 96000,
    });
    const assets = useProjectAudioAssets({
      closeProjectMenu: vi.fn(),
      renderInfo: ref(''),
      positionPpq: ref(4),
      runAction: async (action) => action(),
    });

    const clipId = await assets.placeAssetAtPlayhead('asset-1');

    const clip = store.clips.find((entry) => entry.id === clipId);
    expect(clip?.startPpq).toBe(4);
    expect(clip?.lengthPpq).toBeCloseTo(2, 6);
  });

  it('does not strand an empty audio track when new-track placement fails', async () => {
    assetStore.loadAssetMeta.mockResolvedValue({
      id: 'asset-1',
      name: 'Broken placement',
      sampleRate: 48000,
      numChannels: 1,
      numFrames: 48000,
    });
    const assets = useProjectAudioAssets({
      closeProjectMenu: vi.fn(),
      renderInfo: ref(''),
      positionPpq: ref(0),
      runAction: async (action) => action(),
    });
    clearHistory();
    const initialTrackIds = store.tracks.map((track) => track.id);
    const initialClipIds = store.clips.map((clip) => clip.id);
    const project = getProject();
    const spy = vi.spyOn(project, 'addClip').mockImplementation(() => {
      throw new Error('placement failed');
    });

    await expect(assets.placeAssetAtPlayhead('asset-1')).rejects.toThrow('placement failed');
    spy.mockRestore();

    expect(store.tracks.map((track) => track.id)).toEqual(initialTrackIds);
    expect(store.clips.map((clip) => clip.id)).toEqual(initialClipIds);
    expect(undo()).toBe(false);
  });

  it('redetects clip tempo from the clip source window, not the whole asset', async () => {
    const renderInfo = ref('');
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({
      trackId,
      assetId: 'asset-1',
      startPpq: 0,
      sourceOffsetPpq: 1,
      lengthPpq: 2,
      name: 'Windowed loop',
    });
    assetStore.loadAsset.mockResolvedValue({
      channels: [new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])],
      meta: {
        id: 'asset-1',
        name: 'Loop',
        sampleRate: 4,
        numChannels: 1,
        numFrames: 8,
      },
    });
    audioImport.resolveAudioAnalysis.mockResolvedValue({ detectBpm: vi.fn() });
    audioImport.analyzeAudioTags.mockReturnValue({ bpm: 96.04 });
    const assets = useProjectAudioAssets({
      closeProjectMenu: vi.fn(),
      renderInfo,
      positionPpq: ref(0),
      runAction: async (action) => action(),
    });

    await assets.onRedetectClipTempo(clipId);

    expect(audioImport.analyzeAudioTags).toHaveBeenCalledWith([new Float32Array([3, 4, 5, 6])], 4, {
      detectBpm: expect.any(Function),
    });
    expect(store.clips.find((clip) => clip.id === clipId)?.warp).toMatchObject({
      enabled: false,
      sourceBpm: 96,
    });
    expect(renderInfo.value).toContain('96.0');
  });

  it('skips tempo redetect results when the clip was deleted while loading', async () => {
    const renderInfo = ref('');
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({
      trackId,
      assetId: 'asset-1',
      startPpq: 0,
      sourceOffsetPpq: 0,
      lengthPpq: 2,
      name: 'Loop',
    });
    const pendingAsset = deferred<{
      channels: Float32Array[];
      meta: {
        id: string;
        name: string;
        sampleRate: number;
        numChannels: number;
        numFrames: number;
      };
    }>();
    assetStore.loadAsset.mockReturnValueOnce(pendingAsset.promise);
    audioImport.resolveAudioAnalysis.mockResolvedValue({ detectBpm: vi.fn() });
    audioImport.analyzeAudioTags.mockReturnValue({ bpm: 128 });
    const assets = useProjectAudioAssets({
      closeProjectMenu: vi.fn(),
      renderInfo,
      positionPpq: ref(0),
      runAction: async (action) => action(),
    });

    const redetect = assets.onRedetectClipTempo(clipId);
    deleteClip(clipId);
    pendingAsset.resolve({
      channels: [new Float32Array([1, 2, 3, 4])],
      meta: {
        id: 'asset-1',
        name: 'Loop',
        sampleRate: 4,
        numChannels: 1,
        numFrames: 4,
      },
    });
    await redetect;

    expect(store.clips.find((clip) => clip.id === clipId)).toBeUndefined();
    expect(renderInfo.value).toBe('');
  });

  it('skips tempo redetect results when the clip asset changed while loading', async () => {
    const renderInfo = ref('');
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({
      trackId,
      assetId: 'asset-1',
      startPpq: 0,
      sourceOffsetPpq: 0,
      lengthPpq: 2,
      name: 'Loop',
    });
    const pendingAsset = deferred<{
      channels: Float32Array[];
      meta: {
        id: string;
        name: string;
        sampleRate: number;
        numChannels: number;
        numFrames: number;
      };
    }>();
    assetStore.loadAsset.mockReturnValueOnce(pendingAsset.promise);
    audioImport.resolveAudioAnalysis.mockResolvedValue({ detectBpm: vi.fn() });
    audioImport.analyzeAudioTags.mockReturnValue({ bpm: 128 });
    const assets = useProjectAudioAssets({
      closeProjectMenu: vi.fn(),
      renderInfo,
      positionPpq: ref(0),
      runAction: async (action) => action(),
    });

    const redetect = assets.onRedetectClipTempo(clipId);
    store.clips = store.clips.map((entry) =>
      entry.id === clipId ? { ...entry, assetId: 'asset-2' } : entry,
    );
    pendingAsset.resolve({
      channels: [new Float32Array([1, 2, 3, 4])],
      meta: {
        id: 'asset-1',
        name: 'Loop',
        sampleRate: 4,
        numChannels: 1,
        numFrames: 4,
      },
    });
    await redetect;

    const clip = store.clips.find((entry) => entry.id === clipId);
    expect(clip?.assetId).toBe('asset-2');
    expect(clip?.warp).toBeUndefined();
    expect(renderInfo.value).toBe('');
  });
});
