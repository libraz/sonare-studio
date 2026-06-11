/**
 * Session cache of decoded audio assets and their waveform peak envelopes for
 * arrangement rendering. Assets are loaded from the OPFS asset store at most
 * once and kept at module scope; peak envelopes are cached per (asset id,
 * bucket count) through the shared WaveformPeaksCache.
 *
 * The draw path only ever reads synchronously: {@link requestAudioAsset}
 * returns the cached asset or kicks off one background load and invokes the
 * given callback when it settles, so callers can schedule a repaint without
 * any per-frame OPFS access.
 */

import { type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import { getWasmModule } from '@/project/store';
import {
  type ChannelPeaks,
  createWaveformPeaksCache,
  type WaveformPeaksCache,
  type WaveformPeaksModule,
} from '@/ui/waveform/peaks';

const loadedAssets = new Map<string, LoadedAudioAsset>();
const failedAssets = new Set<string>();
const pendingListeners = new Map<string, Set<() => void>>();
let peaksCache: WaveformPeaksCache | null = null;

/** Builds the peaks cache lazily so the wasm delegate is picked up once ready. */
function ensurePeaksCache(): WaveformPeaksCache {
  if (!peaksCache) {
    let wasm: WaveformPeaksModule | null = null;
    try {
      wasm = getWasmModule();
    } catch {
      wasm = null; // Not initialized yet: pure-TS peak computation.
    }
    peaksCache = createWaveformPeaksCache({ wasm });
  }
  return peaksCache;
}

/**
 * Returns an already-loaded audio asset without triggering any IO.
 *
 * @param assetId - Asset store id.
 * @returns The cached asset, or null when it has not been loaded (yet).
 */
export function getLoadedAudioAsset(assetId: string): LoadedAudioAsset | null {
  return loadedAssets.get(assetId) ?? null;
}

/**
 * Returns the cached asset, or starts one background load and reports back.
 * A failed load is remembered and not retried until invalidated. The
 * callback fires once per request when the load settles (success or
 * failure); duplicate callbacks for the same asset are coalesced.
 *
 * @param assetId - Asset store id.
 * @param onSettled - Invoked after the pending load settles (e.g. to
 *   schedule a repaint). Not called for synchronous cache hits.
 * @returns The cached asset, or null while loading / after a failure.
 */
export function requestAudioAsset(
  assetId: string,
  onSettled?: () => void,
): LoadedAudioAsset | null {
  const cached = loadedAssets.get(assetId);
  if (cached) return cached;
  if (failedAssets.has(assetId)) return null;
  const existing = pendingListeners.get(assetId);
  if (existing) {
    if (onSettled) existing.add(onSettled);
    return null;
  }
  const listeners = new Set<() => void>(onSettled ? [onSettled] : []);
  pendingListeners.set(assetId, listeners);
  void loadAsset(assetId)
    .then((asset) => {
      loadedAssets.set(assetId, asset);
    })
    .catch(() => {
      failedAssets.add(assetId);
    })
    .then(() => {
      pendingListeners.delete(assetId);
      for (const listener of listeners) listener();
    });
  return null;
}

/**
 * Returns the channel-merged peak envelope of an asset at one bucket count,
 * computing and caching it on first use. Treat the result as immutable.
 *
 * @param assetId - Asset store id (cache key component).
 * @param asset - The loaded asset whose channels are scanned on a miss.
 * @param bucketCount - Buckets covering the whole asset (zoom level).
 */
export function audioAssetMergedPeaks(
  assetId: string,
  asset: LoadedAudioAsset,
  bucketCount: number,
): ChannelPeaks {
  return ensurePeaksCache().getMerged(assetId, asset.channels, bucketCount);
}

/**
 * Drops all cached state of one asset (audio, peaks and failure marker) so
 * the next request reloads it.
 */
export function invalidateAudioAsset(assetId: string): void {
  loadedAssets.delete(assetId);
  failedAssets.delete(assetId);
  peaksCache?.invalidate(assetId);
}

/** Drops every cached asset and peak envelope (e.g. on project teardown). */
export function clearAudioClipData(): void {
  loadedAssets.clear();
  failedAssets.clear();
  pendingListeners.clear();
  peaksCache?.clear();
  peaksCache = null;
}
