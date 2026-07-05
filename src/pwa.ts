export const SERVICE_WORKER_URL = '/sw.js';

type ServiceWorkerNavigator = Navigator & {
  serviceWorker?: ServiceWorkerContainer;
};

export interface ServiceWorkerRegistrationTarget {
  readonly environment?: Pick<ImportMetaEnv, 'PROD'>;
  readonly location?: Pick<Location, 'protocol'>;
  readonly navigator?: ServiceWorkerNavigator;
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
  return navigator.serviceWorker?.register(SERVICE_WORKER_URL, { scope: '/' }) ?? null;
}
