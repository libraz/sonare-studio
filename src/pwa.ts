import { readonly, ref } from 'vue';

export const SERVICE_WORKER_URL = '/sw.js';
const CACHE_PREFIX = 'sonare-studio-';

/** Session key shared with the inline app-shell recovery guard in index.html. */
export const SHELL_RECOVERY_KEY = 'sonare-shell-recovery';

/**
 * Clears the one-shot recovery marker now that the entry module has actually
 * run. Without this a session that recovered once could never recover again.
 */
export function markAppShellLoaded(): void {
  try {
    window.sessionStorage?.removeItem(SHELL_RECOVERY_KEY);
  } catch {
    // Session storage can be unavailable (private mode, blocked cookies). The
    // guard then allows no retry at all, which is the safe direction.
  }
}

export type PwaUpdateReason = 'update' | 'engine-version' | 'missing-asset';
export type PwaUpdateFailure = 'autosave';

const updateNoticeState = ref<PwaUpdateReason | null>(null);
export const pwaUpdateNotice = readonly(updateNoticeState);
const updateFailureState = ref<PwaUpdateFailure | null>(null);
/** A preparation failure; the visible update action doubles as a retry. */
export const pwaUpdateFailure = readonly(updateFailureState);

let pendingRegistration: ServiceWorkerRegistration | null = null;
let reloadAfterControllerChange = false;
let reloadPage = (): void => window.location.reload();
let prepareReload: (() => Promise<boolean>) | null = null;

type ServiceWorkerNavigator = Navigator & {
  serviceWorker?: ServiceWorkerContainer;
};

export interface ServiceWorkerRegistrationTarget {
  readonly environment?: Pick<ImportMetaEnv, 'PROD'>;
  readonly location?: Pick<Location, 'protocol'>;
  readonly navigator?: ServiceWorkerNavigator;
  /** Test seam and embedded-shell override for reloading after activation. */
  readonly reload?: () => void;
  /** CacheStorage override used by ABI mismatch recovery. */
  readonly cacheStorage?: CacheStorage;
}

let recoveryCacheStorage: CacheStorage | undefined;

function publishUpdate(registration: ServiceWorkerRegistration, reason: PwaUpdateReason): void {
  pendingRegistration = registration;
  updateNoticeState.value = reason;
  updateFailureState.value = null;
}

/** Requests the same reload affordance when mixed app/engine versions are detected. */
export function requestPwaEngineRecovery(): void {
  updateNoticeState.value = 'engine-version';
  updateFailureState.value = null;
}

/**
 * Requests the same reload affordance when a chunk this build has not loaded
 * yet turns out to be gone. A deployed release replaces the hashed assets of
 * its predecessor, so the first lazy import after a deploy can fail with no
 * interaction to blame it on; without this the feature the user reached for
 * would simply never open.
 */
export function requestPwaAssetRecovery(): void {
  updateNoticeState.value = 'missing-asset';
  updateFailureState.value = null;
}

/**
 * Routes Vite's failed dynamic-import signal into the recovery affordance.
 * Returns an idempotent cleanup for test and app lifecycles.
 */
export function observeMissingChunks(target: EventTarget = window): () => void {
  const handler = (event: Event): void => {
    // Vite rethrows the import rejection unless the event is cancelled; the
    // banner is a better answer than an unhandled rejection.
    event.preventDefault();
    requestPwaAssetRecovery();
  };
  target.addEventListener('vite:preloadError', handler);
  return () => target.removeEventListener('vite:preloadError', handler);
}

export function dismissPwaUpdateNotice(): void {
  updateNoticeState.value = null;
  updateFailureState.value = null;
}

/**
 * Installs the app-level durability barrier run before a PWA-triggered reload.
 * Returns an idempotent cleanup so test/app lifecycles cannot retain a stale
 * project scope.
 */
export function installPwaReloadPreparation(prepare: () => Promise<boolean>): () => void {
  prepareReload = prepare;
  return () => {
    if (prepareReload === prepare) prepareReload = null;
  };
}

function observeRegistration(
  registration: ServiceWorkerRegistration,
  container: ServiceWorkerContainer,
): void {
  let hadController = Boolean(container.controller);
  if (registration.waiting && container.controller) publishUpdate(registration, 'update');
  registration.addEventListener?.('updatefound', () => {
    const installing = registration.installing;
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed' && container.controller) {
        publishUpdate(registration, 'update');
      }
    });
  });
  container.addEventListener?.('controllerchange', () => {
    const wasControlled = hadController;
    hadController = Boolean(container.controller);
    if (reloadAfterControllerChange) {
      reloadAfterControllerChange = false;
      reloadPage();
      return;
    }
    // The first install claiming this page is not a newer app release.
    if (!wasControlled) return;
    // Another client activated a newer release. Activation deletes the cache
    // this document was loaded from, so every chunk this build has not loaded
    // yet is now unreachable. Offer the reload affordance — which runs the
    // autosave barrier — instead of waiting for a lazy import to fail.
    publishUpdate(registration, 'update');
  });
}

async function clearAppCaches(): Promise<void> {
  const storage = recoveryCacheStorage ?? globalThis.caches;
  if (!storage) return;
  const keys = await storage.keys();
  await Promise.all(
    keys.filter((key) => key.startsWith(CACHE_PREFIX)).map((key) => storage.delete(key)),
  );
}

/** Activates a waiting worker, or clears stale app caches before a recovery reload. */
export async function applyPwaUpdateAndReload(): Promise<void> {
  // A worker activation/recovery reload must never strand an autosave write.
  // The app supplies this hook after persistence is initialized.
  if (prepareReload) {
    try {
      if (!(await prepareReload())) {
        updateFailureState.value = 'autosave';
        return;
      }
    } catch {
      updateFailureState.value = 'autosave';
      return;
    }
  }
  updateFailureState.value = null;
  const container = window.navigator.serviceWorker;
  const registration =
    pendingRegistration ?? (container ? await container.getRegistration('/') : undefined);
  if (registration?.waiting) {
    reloadAfterControllerChange = true;
    updateNoticeState.value = null;
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    return;
  }
  await registration?.update().catch(() => undefined);
  if (registration?.waiting) {
    reloadAfterControllerChange = true;
    updateNoticeState.value = null;
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    return;
  }
  await clearAppCaches();
  // Leaving the worker installed would let it refill its emptied release cache
  // one opportunistic response at a time. Dropping it makes the next load come
  // straight from the network — what a forced reload does by hand — after
  // which a fresh worker installs a complete release.
  await registration?.unregister().catch(() => undefined);
  updateNoticeState.value = null;
  reloadPage();
}

export function canRegisterServiceWorker({
  environment = import.meta.env,
  location = window.location,
  navigator = window.navigator,
}: ServiceWorkerRegistrationTarget = {}): boolean {
  return Boolean(environment.PROD && location.protocol !== 'file:' && navigator.serviceWorker);
}

export async function registerServiceWorker(
  target: ServiceWorkerRegistrationTarget = {},
): Promise<ServiceWorkerRegistration | null> {
  const navigator = target.navigator ?? window.navigator;
  if (!canRegisterServiceWorker({ ...target, navigator })) return null;
  reloadPage = target.reload ?? (() => window.location.reload());
  recoveryCacheStorage = target.cacheStorage ?? globalThis.caches;
  const container = navigator.serviceWorker;
  const registration = await container?.register(SERVICE_WORKER_URL, { scope: '/' });
  if (!registration || !container) return null;
  pendingRegistration = registration;
  observeRegistration(registration, container);
  return registration;
}
