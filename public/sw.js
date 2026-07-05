const CACHE_VERSION = 'sonare-studio-v1';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];
const CACHEABLE_PATH_PATTERNS = [
  /^\/assets\//,
  /^\/sonare-engine-worklet\.js$/,
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

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
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
