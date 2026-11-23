const CACHE_VERSION = '__SONARE_CACHE_VERSION__';
const CACHE_PREFIX = 'sonare-studio-';
const PRECACHE_MANIFEST_URL = '/precache-manifest.json';
const SHELL_CACHE_KEY = '/';
const LEGACY_SHELL_CACHE_KEY = '/index.html';
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

const isHtmlResponse = (response) => {
  const contentType = response?.headers?.get('content-type') ?? '';
  return response?.ok && /^\s*text\/html\b/i.test(contentType);
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
    !assets.includes(SHELL_CACHE_KEY) ||
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
 * Cloudflare Pages may answer `/index.html` with a redirect to `/`. A
 * redirected Response is valid for fetch(), but putting it in Cache Storage
 * and returning it for a navigation can make Chromium reject the navigation
 * with `net::ERR_FAILED`. Rebuild the document response so the cache contains
 * an ordinary 200 response whose URL is the canonical shell key.
 */
const normalizeShellResponse = async (response) => {
  if (!response?.redirected) return response;
  const headers = {};
  response.headers?.forEach((value, name) => {
    const lowerName = name.toLowerCase();
    if (
      lowerName !== 'location' &&
      lowerName !== 'content-encoding' &&
      lowerName !== 'content-length' &&
      lowerName !== 'transfer-encoding'
    ) {
      headers[name] = value;
    }
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/**
 * Repairs a shell cached by an older worker before that worker gets another
 * navigation. The old worker still owns the page while this worker waits, so
 * the old cache is deliberately kept and repaired in place. A failure here is
 * isolated to that cache; it must never make the active release disappear.
 */
const migrateLegacyShellCaches = async () => {
  const keys = await caches.keys();
  for (const key of keys) {
    if (!key.startsWith(CACHE_PREFIX) || key === CACHE_VERSION) continue;
    try {
      const cache = await caches.open(key);
      const legacy = await cache.match(LEGACY_SHELL_CACHE_KEY);
      const root = await cache.match(SHELL_CACHE_KEY);
      if (isHtmlResponse(legacy)) {
        const normalizedLegacy = await normalizeShellResponse(legacy);
        await cache.put(LEGACY_SHELL_CACHE_KEY, normalizedLegacy.clone());
        if (!isHtmlResponse(root)) await cache.put(SHELL_CACHE_KEY, normalizedLegacy.clone());
      }
      if (isHtmlResponse(root) && root.redirected) {
        const normalizedRoot = await normalizeShellResponse(root);
        await cache.put(SHELL_CACHE_KEY, normalizedRoot.clone());
      }
    } catch {
      // A storage error in an old cache must not abort this release's install.
    }
  }
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
  if (!response.ok) throw new Error(`answered with status ${response.status}`);
  if (isShellFallback(new URL(asset, self.location.origin), response)) {
    throw new Error('answered with the app shell');
  }
  if (
    (asset === SHELL_CACHE_KEY || asset === LEGACY_SHELL_CACHE_KEY) &&
    !isHtmlResponse(response)
  ) {
    throw new Error('answered without an HTML shell');
  }
  const normalized = isDocumentPath(new URL(asset, self.location.origin).pathname)
    ? await normalizeShellResponse(response)
    : response;
  const cacheKey = asset === LEGACY_SHELL_CACHE_KEY ? SHELL_CACHE_KEY : request;
  await cache.put(cacheKey, normalized);
};

const precacheAppShell = async () => {
  // A cache that already exists belongs to a complete install this call is repairing.
  const existed = await caches.has(CACHE_VERSION);
  try {
    const assets = await loadPrecacheManifest();
    const cache = await caches.open(CACHE_VERSION);
    // Settle every entry before reporting a failure: a write still in flight
    // would otherwise land after the cleanup below had already run.
    const results = await Promise.allSettled(
      assets.map((asset) =>
        // A rejected fetch or cache write carries no URL of its own, so every
        // failure is reported against the asset that caused it.
        precacheAsset(cache, asset).catch((error) => {
          throw new Error(`Precache failed: ${asset}: ${error?.message ?? error}`, {
            cause: error,
          });
        }),
      ),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  } catch (error) {
    // A failed install must not leave a partially populated release cache that
    // a retry could mistake for a complete install. A failed repair keeps the
    // cache the open page is still loading chunks from.
    if (!existed) await caches.delete(CACHE_VERSION);
    throw error;
  }
};

self.addEventListener('install', (event) => {
  // Updated workers remain waiting until the in-app reload action sends
  // SKIP_WAITING. A first install still activates normally because no worker
  // controls the scope yet.
  event.waitUntil(
    migrateLegacyShellCaches()
      .catch(() => undefined)
      .then(precacheAppShell),
  );
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
  try {
    const cache = await caches.open(CACHE_VERSION);
    // Keep the active release internally consistent while an updated worker
    // waits. The new index becomes visible only after activation.
    const cachedRoot = await cache.match(SHELL_CACHE_KEY);
    const cachedLegacy = await cache.match(LEGACY_SHELL_CACHE_KEY);
    for (const cached of [cachedRoot, cachedLegacy]) {
      if (!isHtmlResponse(cached)) continue;
      const normalized = await normalizeShellResponse(cached);
      if (cached === cachedLegacy || cached.redirected) {
        try {
          await cache.put(SHELL_CACHE_KEY, normalized.clone());
        } catch {
          // A storage write failure must not turn a usable shell into a
          // browser-level navigation error.
        }
      }
      return normalized;
    }
  } catch {
    // Storage eviction and transient Cache Storage failures are recoverable
    // through the complete precache or the live network document below.
  }
  try {
    await precacheAppShell();
    const repaired = await (await caches.open(CACHE_VERSION)).match(SHELL_CACHE_KEY);
    if (isHtmlResponse(repaired)) return repaired;
  } catch {
    // The deployed release has moved past this worker; serve the live document
    // without caching it, and let the newer worker install as usual.
  }
  try {
    const response = await fetch(new Request(SHELL_CACHE_KEY, { cache: 'reload' }));
    if (!isHtmlResponse(response)) throw new Error('Live shell response was not HTML');
    return await normalizeShellResponse(response);
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
