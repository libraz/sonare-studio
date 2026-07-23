import { readonly, ref } from 'vue';

export const SERVICE_WORKER_URL = '/sw.js';
const CACHE_PREFIX = 'sonare-studio-';

export type PwaUpdateReason = 'update' | 'engine-version';

const updateNoticeState = ref<PwaUpdateReason | null>(null);
export const pwaUpdateNotice = readonly(updateNoticeState);

let pendingRegistration: ServiceWorkerRegistration | null = null;
let reloadAfterControllerChange = false;
let reloadPage = (): void => window.location.reload();
let prepareReload: (() => Promise<void>) | null = null;

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
}

/** Requests the same reload affordance when mixed app/engine versions are detected. */
export function requestPwaEngineRecovery(): void {
  updateNoticeState.value = 'engine-version';
}

export function dismissPwaUpdateNotice(): void {
  updateNoticeState.value = null;
}

/**
 * Installs the app-level durability barrier run before a PWA-triggered reload.
 * Returns an idempotent cleanup so test/app lifecycles cannot retain a stale
 * project scope.
 */
export function installPwaReloadPreparation(prepare: () => Promise<void>): () => void {
  prepareReload = prepare;
  return () => {
    if (prepareReload === prepare) prepareReload = null;
  };
}

function observeRegistration(
  registration: ServiceWorkerRegistration,
  container: ServiceWorkerContainer,
): void {
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
    if (!reloadAfterControllerChange) return;
    reloadAfterControllerChange = false;
    reloadPage();
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
  await prepareReload?.();
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
