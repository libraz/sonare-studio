/**
 * Tab-lifetime media leases over the live document, and the hand-off of the
 * temporary lease a bundle restore takes before its document becomes live.
 */

import { onScopeDispose, type Ref, watchEffect } from 'vue';
import { describeError } from '@/lib/errors';
import { leaseAudioAssets, leaseFonts } from '@/persistence/asset-leases';
import type { ProjectBundleRestoreLease } from '@/persistence/bundle';
import { collectReferencedAudioAssetIds } from '@/project/asset-references';
import { collectHistoryReferencedMediaIds } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';

/** Configuration for {@link useLiveMediaLeases}. */
export interface LiveMediaLeasesOptions {
  /** The shell error banner, set when a lease cannot be updated. */
  errorMessage: Ref<string>;
}

/** Bundle-lease hand-off returned by {@link useLiveMediaLeases}. */
export interface LiveMediaLeases {
  /** Keeps a bundle lease held and retries its hand-off until the live lease takes over. */
  holdBundleRestoreLease(lease: ProjectBundleRestoreLease): void;
  /** Moves a bundle lease's ids onto the live-document lease, then releases it. */
  handOffBundleRestoreLease(lease: ProjectBundleRestoreLease): void;
}

/**
 * Holds the live document's audio assets and SoundFonts under cross-tab leases
 * for the lifetime of the calling scope.
 *
 * @param options - The error banner lease failures are reported to.
 * @returns The bundle-lease hold and hand-off operations.
 */
export function useLiveMediaLeases(options: LiveMediaLeasesOptions): LiveMediaLeases {
  const { errorMessage } = options;
  const store = useProjectStore();
  const { t } = useI18n();

  // Hold a tab-lifetime lease over the live document's media so another tab's
  // GC — which cannot see this tab's unsaved Pinia document, and whose autosave
  // slot may be up to 30 s behind — never deletes an asset or SoundFont this
  // tab still references. The lease is broadcast cross-tab (asset-leases.ts).
  const liveAssetLease = leaseAudioAssets([]);
  const liveFontLease = leaseFonts([]);
  // A bundle lease that could not be handed off immediately stays here until
  // the live-document lease can acquire the same ids. This is deliberately
  // safer than dropping protection during a concurrent tab's delete intent.
  const pendingBundleRestoreLeases = new Set<ProjectBundleRestoreLease>();
  let bundleLeaseRetryTimer: ReturnType<typeof setTimeout> | undefined;

  function updateLiveMediaLeases(): void {
    const fontIds = new Set<string>();
    for (const track of store.tracks) {
      if (track.instrument?.kind === 'sf2' && track.instrument.fontId) {
        fontIds.add(track.instrument.fontId);
      }
    }
    const historyRefs = collectHistoryReferencedMediaIds();
    const assetIds = collectReferencedAudioAssetIds(store.clips, store.tracks);
    for (const assetId of historyRefs.assetIds) assetIds.add(assetId);
    for (const fontId of historyRefs.fontIds) fontIds.add(fontId);
    liveAssetLease.update(assetIds);
    liveFontLease.update(fontIds);
  }

  function releasePendingBundleRestoreLeases(): void {
    for (const lease of pendingBundleRestoreLeases) lease.release();
    pendingBundleRestoreLeases.clear();
    if (bundleLeaseRetryTimer !== undefined) {
      clearTimeout(bundleLeaseRetryTimer);
      bundleLeaseRetryTimer = undefined;
    }
  }

  function scheduleBundleLeaseRetry(): void {
    if (pendingBundleRestoreLeases.size === 0 || bundleLeaseRetryTimer !== undefined) return;
    // GC waits at most one known-peer lease-synchronization interval before
    // completing its intent, so retry after that window while the temporary
    // bundle lease remains continuously advertised.
    bundleLeaseRetryTimer = setTimeout(() => {
      bundleLeaseRetryTimer = undefined;
      try {
        updateLiveMediaLeases();
        releasePendingBundleRestoreLeases();
      } catch (error) {
        errorMessage.value = describeError(error, t.value.notices.errors);
        scheduleBundleLeaseRetry();
      }
    }, 1_100);
  }

  function holdBundleRestoreLease(lease: ProjectBundleRestoreLease): void {
    pendingBundleRestoreLeases.add(lease);
    scheduleBundleLeaseRetry();
  }

  function handOffBundleRestoreLease(lease: ProjectBundleRestoreLease): void {
    try {
      // Do this explicitly rather than merely waiting for the watcher: the
      // temporary bundle lease may be released only after the tab-lifetime
      // lease has definitely acquired every document reference.
      updateLiveMediaLeases();
      lease.release();
    } catch (error) {
      errorMessage.value = describeError(error, t.value.notices.errors);
      holdBundleRestoreLease(lease);
    }
  }

  watchEffect(() => {
    try {
      updateLiveMediaLeases();
      releasePendingBundleRestoreLeases();
    } catch (error) {
      // A live document reference must never be silently abandoned. Existing
      // pending bundle leases remain held and the retry path keeps trying.
      errorMessage.value = describeError(error, t.value.notices.errors);
      scheduleBundleLeaseRetry();
    }
  });
  onScopeDispose(() => {
    if (bundleLeaseRetryTimer !== undefined) clearTimeout(bundleLeaseRetryTimer);
    for (const lease of pendingBundleRestoreLeases) lease.release();
    pendingBundleRestoreLeases.clear();
    liveAssetLease.release();
    liveFontLease.release();
  });

  return { holdBundleRestoreLease, handOffBundleRestoreLease };
}
