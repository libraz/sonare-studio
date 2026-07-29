import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import {
  clearAudioClipData,
  getLoadedAudioAsset,
  invalidateAudioAsset,
  MAX_AUDIO_CLIP_CACHE_BYTES,
  requestAudioAsset,
} from '@/ui/arrangement/audio-clip-data';

const assetStore = vi.hoisted(() => ({
  loadAsset: vi.fn<(id: string) => Promise<LoadedAudioAsset>>(),
}));
vi.mock('@/persistence/assets', () => assetStore);

/** Creates a manually-resolved promise for async race tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function loaded(id: string): LoadedAudioAsset {
  return {
    meta: {
      id,
      name: id,
      sampleRate: 48000,
      numChannels: 1,
      numFrames: 8,
    },
    channels: [new Float32Array(8)],
  };
}

async function flushLoadChain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('audio clip data cache', () => {
  beforeEach(() => {
    clearAudioClipData();
    vi.clearAllMocks();
  });

  it('does not cache or notify a pending load after the cache is cleared', async () => {
    const pending = deferred<LoadedAudioAsset>();
    const settled = vi.fn();
    assetStore.loadAsset.mockReturnValueOnce(pending.promise);

    expect(requestAudioAsset('asset-a', settled)).toBeNull();
    clearAudioClipData();
    pending.resolve(loaded('asset-a'));
    await flushLoadChain();

    expect(getLoadedAudioAsset('asset-a')).toBeNull();
    expect(settled).not.toHaveBeenCalled();
  });

  it('does not cache or notify a pending load after that asset is invalidated', async () => {
    const pending = deferred<LoadedAudioAsset>();
    const settled = vi.fn();
    assetStore.loadAsset.mockReturnValueOnce(pending.promise);

    expect(requestAudioAsset('asset-a', settled)).toBeNull();
    invalidateAudioAsset('asset-a');
    pending.resolve(loaded('asset-a'));
    await flushLoadChain();

    expect(getLoadedAudioAsset('asset-a')).toBeNull();
    expect(settled).not.toHaveBeenCalled();
  });

  it('allows a fresh request after invalidating a pending load', async () => {
    const stale = deferred<LoadedAudioAsset>();
    const fresh = deferred<LoadedAudioAsset>();
    const staleSettled = vi.fn();
    const freshSettled = vi.fn();
    assetStore.loadAsset.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

    expect(requestAudioAsset('asset-a', staleSettled)).toBeNull();
    invalidateAudioAsset('asset-a');
    expect(requestAudioAsset('asset-a', freshSettled)).toBeNull();
    stale.resolve(loaded('asset-a-stale'));
    fresh.resolve(loaded('asset-a'));
    await flushLoadChain();

    expect(getLoadedAudioAsset('asset-a')?.meta.id).toBe('asset-a');
    expect(staleSettled).not.toHaveBeenCalled();
    expect(freshSettled).toHaveBeenCalledOnce();
  });

  it('evicts older decoded PCM when the bounded render cache is full', async () => {
    const oversized = {
      ...loaded('asset-a'),
      channels: [{ byteLength: MAX_AUDIO_CLIP_CACHE_BYTES }],
    } as unknown as LoadedAudioAsset;
    const next = {
      ...loaded('asset-b'),
      channels: [{ byteLength: 1 }],
    } as unknown as LoadedAudioAsset;
    assetStore.loadAsset.mockResolvedValueOnce(oversized).mockResolvedValueOnce(next);

    requestAudioAsset('asset-a');
    await flushLoadChain();
    requestAudioAsset('asset-b');
    await flushLoadChain();

    expect(getLoadedAudioAsset('asset-a')).toBeNull();
    expect(getLoadedAudioAsset('asset-b')).toBe(next);
  });
});
