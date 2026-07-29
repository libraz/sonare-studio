const CACHE_VERSION = '__SONARE_CACHE_VERSION__';
const CACHE_PREFIX = 'sonare-studio-';
const PRECACHE_MANIFEST_URL = '/precache-manifest.json';
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

const loadPrecacheManifest = async () => {
  const response = await fetch(PRECACHE_MANIFEST_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Precache manifest fetch failed: ${response.status}`);
  }
  const manifest = await response.json();
  if (manifest?.cacheVersion !== CACHE_VERSION || !Array.isArray(manifest.assets)) {
    throw new Error('Precache manifest does not match this Service Worker release');
  }
  const assets = [...new Set(manifest.assets)];
  if (
    !assets.includes('/index.html') ||
    !assets.includes('/worklet-manifest.json') ||
    !assets.some((asset) => /^\/assets\/.+\.js$/i.test(asset)) ||
    assets.some((asset) => {
      if (typeof asset !== 'string' || !asset.startsWith('/')) return true;
      const url = new URL(asset, self.location.origin);
      return url.origin !== self.location.origin || `${url.pathname}${url.search}` !== asset;
    })
  ) {
    throw new Error('Precache manifest contains an invalid or incomplete asset list');
  }
  return assets;
};

const precacheAppShell = async () => {
  try {
    const assets = await loadPrecacheManifest();
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(assets.map((asset) => new Request(asset, { cache: 'reload' })));
  } catch (error) {
    // A failed update must not leave a partially populated release cache that
    // a retry could mistake for a complete install.
    await caches.delete(CACHE_VERSION);
    throw error;
  }
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

/**
 * Serves the document that belongs to this release.
 *
 * A release cache can lose its shell while this worker stays active — storage
 * eviction, or the in-app recovery clear. Repairing it by re-running the whole
 * precache keeps the cache all-or-nothing. Caching a single network-fetched
 * document here instead would pin whatever the HTTP cache or an edge happened
 * to return, and a document from another release points at hashed assets this
 * release does not hold: the app then fails to boot, and because the document
 * is served cache-first no ordinary reload can escape it.
 */
const serveAppShell = async () => {
  const cache = await caches.open(CACHE_VERSION);
  // Keep the active release internally consistent while an updated worker
  // waits. The new index becomes visible only after activation.
  const cached = await cache.match('/index.html');
  if (cached) return cached;
  try {
    await precacheAppShell();
    const repaired = await (await caches.open(CACHE_VERSION)).match('/index.html');
    if (repaired) return repaired;
  } catch {
    // The deployed release has moved past this worker; serve the live document
    // without caching it, and let the newer worker install as usual.
  }
  return fetch(new Request('/index.html', { cache: 'reload' }));
};

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isCacheableRequest(request)) return;

  const url = new URL(request.url);
  if (request.mode === 'navigate') {
    event.respondWith(serveAppShell());
    return;
  }

  if (CACHEABLE_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname))) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        // Only content-addressed assets may join the release cache on a miss:
        // their URL implies their bytes, so a response from another release
        // cannot occupy a name this release also serves.
        if (url.pathname.startsWith('/assets/')) return putIfCacheable(cache, request, response);
        return response;
      }),
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      try {
        return await putIfCacheable(cache, request, await fetch(request));
      } catch {
        return cache.match(request);
      }
    }),
  );
});
