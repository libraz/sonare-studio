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

const isDocumentPath = (pathname) => pathname.endsWith('/') || pathname.endsWith('.html');

/**
 * Detects the app document answering under a URL that should carry an asset.
 *
 * The static host rewrites every unmatched path onto `index.html` with status
 * 200, so a URL the current deploy no longer serves does not 404 — it returns a
 * document. Under an asset URL that document can never parse as a script, a
 * module or wasm, and admitting it to the release cache pins the failure for
 * the whole release: every ordinary reload replays it, and only a forced reload
 * — which bypasses this worker entirely — escapes. Both the precache and the
 * runtime cache therefore check a response against the shape its URL promises.
 */
const isShellFallback = (url, response) => {
  if (isDocumentPath(url.pathname)) return false;
  const contentType = response?.headers?.get('content-type') ?? '';
  return /^\s*text\/html\b/i.test(contentType);
};

/**
 * Stands in for an asset whose release is gone. A missing resource is what the
 * document's recovery guard can act on; the shell fallback it replaces would
 * instead surface as an unparseable script and leave the page blank.
 */
const staleAssetResponse = () =>
  new Response('', { status: 404, statusText: 'Stale release asset' });

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

/**
 * Fetches one precache entry and admits it only if it is the asset it claims to
 * be. `cache.addAll` cannot do this: it accepts any 2xx, so an asset served by
 * an edge that has not caught up with the deploy would install as a document
 * and make this release permanently unbootable.
 */
const precacheAsset = async (cache, asset) => {
  const request = new Request(asset, { cache: 'reload' });
  const response = await fetch(request);
  if (!response.ok) throw new Error(`Precache fetch failed: ${asset} (${response.status})`);
  if (isShellFallback(new URL(asset, self.location.origin), response)) {
    throw new Error(`Precache fetch answered with the app shell: ${asset}`);
  }
  await cache.put(request, response);
};

const precacheAppShell = async () => {
  try {
    const assets = await loadPrecacheManifest();
    const cache = await caches.open(CACHE_VERSION);
    // Settle every entry before reporting a failure: a write still in flight
    // would otherwise land after the cleanup below had already run.
    const results = await Promise.allSettled(assets.map((asset) => precacheAsset(cache, asset)));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
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
 * Last-resort document shown when no release cache holds a shell and the
 * network cannot supply one. It replaces the browser's own network-error page,
 * which gives a user no way forward other than a forced reload, with the same
 * cache-and-worker reset the in-document recovery guard performs.
 *
 * English only: the worker has no access to the app's language setting, and a
 * page that guesses reads worse than one that does not.
 */
const RECOVERY_DOCUMENT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>sonare studio</title>
    <style>
      html, body { height: 100% }
      body {
        margin: 0; display: grid; place-items: center; text-align: center;
        background: #0b0d10; color: #e6e9ef; font: 16px/1.7 system-ui, sans-serif;
      }
      main { max-width: 34rem; padding: 2rem }
      button {
        margin-top: 1.5rem; padding: 0.6rem 1.4rem; border: 1px solid #3b4250;
        border-radius: 0.5rem; background: #1a1f27; color: inherit; font: inherit; cursor: pointer;
      }
    </style>
  </head>
  <body>
    <main>
      <p>sonare studio could not be loaded. Check your connection and try again.</p>
      <button type="button" id="retry">Retry</button>
    </main>
    <script>
      document.getElementById('retry').addEventListener('click', function () {
        var pending = [];
        if (window.caches) {
          pending.push(caches.keys().then(function (keys) {
            return Promise.all(keys
              .filter(function (key) { return key.indexOf('${CACHE_PREFIX}') === 0 })
              .map(function (key) { return caches.delete(key) }));
          }));
        }
        if (navigator.serviceWorker) {
          pending.push(navigator.serviceWorker.getRegistrations().then(function (registrations) {
            return Promise.all(registrations.map(function (r) { return r.unregister() }));
          }));
        }
        Promise.all(pending).catch(function () {}).then(function () { location.reload() });
      });
    </script>
  </body>
</html>
`;

const recoveryDocument = () =>
  new Response(RECOVERY_DOCUMENT, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8' },
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
  try {
    return await fetch(new Request('/index.html', { cache: 'reload' }));
  } catch {
    return recoveryDocument();
  }
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
        if (isShellFallback(url, response)) return staleAssetResponse();
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
        const response = await fetch(request);
        if (isShellFallback(url, response)) return staleAssetResponse();
        return await putIfCacheable(cache, request, response);
      } catch {
        // Resolving to undefined would fail the request at the browser level
        // rather than as a response the app can handle.
        return (await cache.match(request)) ?? new Response('', { status: 504 });
      }
    }),
  );
});
