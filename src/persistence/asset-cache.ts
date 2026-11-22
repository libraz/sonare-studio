/** Byte-budgeted LRU of decoded audio assets kept for repeated playback use. */

import { MEBIBYTE } from '@/lib/bytes';
import { deinterleaveChannels } from './asset-pcm';
import type { AudioAssetMeta, LoadedAudioAsset } from './assets';

/** In-memory cache of loaded assets (playback re-schedules often). */
const audioCache = new Map<string, LoadedAudioAsset>();

/** Default retained PCM budget for the decoded-audio LRU (256 MiB). */
export const DEFAULT_AUDIO_ASSET_CACHE_BYTE_BUDGET = 256 * MEBIBYTE;

let audioCacheByteBudget = DEFAULT_AUDIO_ASSET_CACHE_BYTE_BUDGET;
let audioCacheBytes = 0;

function loadedAssetBytes(asset: LoadedAudioAsset): number {
  return asset.channels.reduce((sum, channel) => sum + channel.byteLength, 0);
}

export function removeCachedAsset(id: string): void {
  const existing = audioCache.get(id);
  if (!existing) return;
  audioCache.delete(id);
  audioCacheBytes -= loadedAssetBytes(existing);
}

export function cachedAsset(id: string): LoadedAudioAsset | undefined {
  const cached = audioCache.get(id);
  if (!cached) return undefined;
  // Map insertion order is the LRU order. Returned buffers remain alive for
  // current consumers even if a later insertion evicts this cache reference.
  audioCache.delete(id);
  audioCache.set(id, cached);
  return cached;
}

export function cacheAsset(id: string, asset: LoadedAudioAsset): void {
  removeCachedAsset(id);
  const bytes = loadedAssetBytes(asset);
  if (bytes > audioCacheByteBudget) return;
  while (audioCache.size > 0 && audioCacheBytes + bytes > audioCacheByteBudget) {
    const oldest = audioCache.keys().next().value;
    if (oldest === undefined) break;
    removeCachedAsset(oldest);
  }
  audioCache.set(id, asset);
  audioCacheBytes += bytes;
}

/**
 * Warms the cache after a save, deinterleaving only when the result is kept.
 * Unchanged content never re-deinterleaves: a cached entry just takes the
 * latest metadata, and an uncached one stays uncached.
 */
export function cacheSavedAsset(
  meta: AudioAssetMeta,
  interleaved: Float32Array,
  numChannels: number,
  created: boolean,
): void {
  const existing = audioCache.get(meta.id);
  if (!created && !existing) return;
  if (interleaved.byteLength > audioCacheByteBudget) {
    removeCachedAsset(meta.id);
    return;
  }
  const channels =
    !created && existing ? existing.channels : deinterleaveChannels(interleaved, numChannels);
  cacheAsset(meta.id, { meta, channels });
}

/** Current decoded-audio LRU usage for diagnostics and memory tests. */
export function audioAssetCacheStats(): {
  entries: number;
  bytes: number;
  budgetBytes: number;
  /** Least-recently-used to most-recently-used ids. */
  ids: string[];
} {
  return {
    entries: audioCache.size,
    bytes: audioCacheBytes,
    budgetBytes: audioCacheByteBudget,
    ids: [...audioCache.keys()],
  };
}

/** Sets the decoded-audio cache byte budget and evicts least-recently-used entries. */
export function configureAudioAssetCacheByteBudget(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError(`Audio cache byte budget must be finite and >= 0, got ${bytes}`);
  }
  audioCacheByteBudget = Math.floor(bytes);
  while (audioCacheBytes > audioCacheByteBudget && audioCache.size > 0) {
    const oldest = audioCache.keys().next().value;
    if (oldest === undefined) break;
    removeCachedAsset(oldest);
  }
}

/** Drops all cached asset audio (tests, memory pressure handling). */
export function clearAudioAssetCache(): void {
  audioCache.clear();
  audioCacheBytes = 0;
}
