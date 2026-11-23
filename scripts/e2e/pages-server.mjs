import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webm': 'audio/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const COI_HEADERS = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

// This is the navigation policy shipped by the previous release. It follows
// Pages' /index.html redirect into Cache Storage, then serves that redirected
// response for every document navigation. The production scenario installs it
// before publishing B so the new worker has to repair a real old cache while
// the old worker is still active.
const LEGACY_SERVICE_WORKER = `
const CACHE = 'sonare-studio-legacy';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const response = await fetch('/index.html');
    await cache.put('/index.html', response.clone());
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then(async (cache) => {
      return (await cache.match('/index.html')) ?? fetch(request);
    }));
    return;
  }
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      await cache.put(request, response.clone());
      return response;
    }));
  }
});
`;

function cacheControl(pathname) {
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/sw.js' ||
    pathname === '/precache-manifest.json' ||
    pathname === '/worklet-manifest.json'
  ) {
    return 'no-cache';
  }
  return null;
}

function safeFilePath(root, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const candidate = resolve(root, normalize(relativePath));
  const rootRelative = relative(root, candidate);
  if (rootRelative.startsWith('..') || rootRelative.includes(`..${sep}`)) return null;
  return candidate;
}

async function readRelease(releaseId, base) {
  if (releaseId === 'a') return base;
  const cacheVersion = `${base.cacheVersion}-${releaseId}`;
  return {
    cacheVersion,
    manifest: `${JSON.stringify({ ...base.parsedManifest, cacheVersion }, null, 2)}\n`,
    serviceWorker: base.serviceWorker.replaceAll(base.cacheVersion, cacheVersion),
  };
}

/**
 * Serves a Vite dist directory with the redirects and headers Cloudflare Pages
 * applies to this app. The release switch lets the standalone browser test
 * exercise a waiting worker without copying a second build tree.
 */
export async function createPagesServer({ dist, host = '127.0.0.1', port = 0 } = {}) {
  const root = resolve(dist ?? join(process.cwd(), 'dist'));
  const [manifestText, serviceWorker] = await Promise.all([
    readFile(join(root, 'precache-manifest.json'), 'utf8'),
    readFile(join(root, 'sw.js'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);
  if (typeof manifest.cacheVersion !== 'string' || !Array.isArray(manifest.assets)) {
    throw new Error(`Invalid production precache manifest in ${root}`);
  }
  const base = {
    cacheVersion: manifest.cacheVersion,
    manifest: manifestText,
    parsedManifest: manifest,
    serviceWorker: serviceWorker.toString(),
  };
  const releases = new Map([['a', base]]);
  let activeRelease = 'a';
  let serviceWorkerVariant = 'current';
  let online = true;
  let failurePath = null;
  const requests = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const entry = {
      method: request.method ?? 'GET',
      pathname: url.pathname,
      release: activeRelease,
      status: null,
      completed: false,
    };
    requests.push(entry);
    response.on('close', () => {
      entry.status = response.statusCode;
      entry.completed = response.writableFinished;
    });
    const commonHeaders = { ...COI_HEADERS };
    if (!online) {
      request.socket.destroy();
      return;
    }
    if (failurePath === url.pathname) {
      response.writeHead(503, { ...commonHeaders, 'content-type': 'text/plain; charset=utf-8' });
      response.end('partial release');
      return;
    }

    const release = releases.get(activeRelease);
    if (!release) {
      response.writeHead(500, commonHeaders);
      response.end('unknown release');
      return;
    }
    if (url.pathname === '/index.html') {
      response.writeHead(308, { ...commonHeaders, 'cache-control': 'no-cache', location: '/' });
      response.end();
      return;
    }
    if (url.pathname === '/sw.js') {
      response.writeHead(200, {
        ...commonHeaders,
        'cache-control': 'no-cache',
        'content-type': 'text/javascript; charset=utf-8',
      });
      response.end(
        serviceWorkerVariant === 'legacy' ? LEGACY_SERVICE_WORKER : release.serviceWorker,
      );
      return;
    }
    if (url.pathname === '/legacy-probe.html') {
      response.writeHead(200, {
        ...commonHeaders,
        'cache-control': 'no-cache',
        'content-type': 'text/html; charset=utf-8',
      });
      response.end('<!doctype html><title>legacy worker probe</title><main>ready</main>');
      return;
    }
    if (url.pathname === '/precache-manifest.json') {
      response.writeHead(200, {
        ...commonHeaders,
        'cache-control': 'no-cache',
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(release.manifest);
      return;
    }

    const filePath = safeFilePath(root, url.pathname);
    let body;
    const pathnameForCache = url.pathname;
    let pathnameForContentType = url.pathname === '/' ? '/index.html' : url.pathname;
    try {
      body = filePath ? await readFile(filePath) : null;
    } catch {
      body = null;
    }
    // Pages' catch-all rewrite returns the app document with 200 even for a
    // missing content-addressed asset. The Service Worker rejects that HTML
    // under an asset URL instead of pinning it as a script.
    if (!body) {
      body = await readFile(join(root, 'index.html'));
      pathnameForContentType = '/index.html';
    }
    if (!body) {
      response.writeHead(404, { ...commonHeaders, 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    const headers = {
      ...commonHeaders,
      // A chunked 8 MB wasm body failed the worker's Cache.put in 10 of 20 installs.
      'content-length': String(body.byteLength),
      'content-type':
        MIME_TYPES[extname(pathnameForContentType).toLowerCase()] ?? 'application/octet-stream',
    };
    const cache = cacheControl(pathnameForCache);
    if (cache) headers['cache-control'] = cache;
    response.writeHead(200, headers);
    response.end(body);
  });

  await new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveServer);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    baseUrl: `http://${host}:${actualPort}`,
    clearRequests() {
      requests.length = 0;
    },
    close() {
      return new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
    getRequests() {
      return [...requests];
    },
    async addRelease(releaseId) {
      const release = await readRelease(releaseId, base);
      releases.set(releaseId, release);
      return release.cacheVersion;
    },
    setFailure(pathname) {
      failurePath = pathname;
    },
    setOnline(value) {
      online = value;
    },
    setServiceWorkerVariant(variant) {
      if (variant !== 'current' && variant !== 'legacy') {
        throw new Error(`Unknown Service Worker variant: ${variant}`);
      }
      serviceWorkerVariant = variant;
    },
    setRelease(releaseId) {
      if (!releases.has(releaseId)) throw new Error(`Unknown Pages release: ${releaseId}`);
      activeRelease = releaseId;
      failurePath = null;
      serviceWorkerVariant = 'current';
    },
  };
}
