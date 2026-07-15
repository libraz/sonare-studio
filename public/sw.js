const CACHE_VERSION = 'sonare-studio-v2';
const CACHE_PREFIX = 'sonare-studio-';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/worklet-manifest.json',
];
const CACHEABLE_PATH_PATTERNS = [
  /^\/assets\//,
  /\.(?:css|js|mjs|wasm|woff2?|svg|png|jpg|jpeg|webp)$/i,
];

const isCacheableRequest = (request) => {
  if (request.method !== 'GET') return false;
  if (request.headers.has('range')) return false;
  const url = new URL(request.url);
  return url.origin === self.location.origin;
};

const isCacheableResponse = (response) => {
  return response?.ok && (response.type === 'basic' || response.type === 'default');
};

const putIfCacheable = async (cache, request, response) => {
  if (isCacheableResponse(response)) await cache.put(request, response.clone());
  return response;
};

const precacheAppShell = async () => {
  const workletManifestResponse = await fetch('/worklet-manifest.json', { cache: 'no-store' });
  if (!workletManifestResponse.ok) {
    throw new Error(`Worklet manifest fetch failed: ${workletManifestResponse.status}`);
  }
  const workletManifest = await workletManifestResponse.clone().json();
  if (
    typeof workletManifest.moduleUrl !== 'string' ||
    !workletManifest.moduleUrl.startsWith('/assets/sonare-engine-worklet-')
  ) {
    throw new Error('Worklet manifest has an invalid module URL');
  }
  const cache = await caches.open(CACHE_VERSION);
  await cache.addAll([
    ...APP_SHELL.filter((url) => url !== '/worklet-manifest.json'),
    workletManifest.moduleUrl,
  ]);
  await cache.put('/worklet-manifest.json', workletManifestResponse);
};

self.addEventListener('install', (event) => {
  // Updated workers remain waiting until the in-app reload action sends
  // SKIP_WAITING. A first install still activates normally because no worker
  // controls the scope yet.
  event.waitUntil(precacheAppShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isCacheableRequest(request)) return;

  const url = new URL(request.url);
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          const cache = await caches.open(CACHE_VERSION);
          await putIfCacheable(cache, '/index.html', response);
          return response;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  if (CACHEABLE_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname))) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then(async (response) => {
          const cache = await caches.open(CACHE_VERSION);
          return putIfCacheable(cache, request, response);
        });
      }),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then(async (response) => {
        const cache = await caches.open(CACHE_VERSION);
        return putIfCacheable(cache, request, response);
      })
      .catch(() => caches.match(request)),
  );
});
