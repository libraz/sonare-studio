import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPwaUpdateAndReload,
  canRegisterServiceWorker,
  dismissPwaUpdateNotice,
  installPwaReloadPreparation,
  observeMissingChunks,
  pwaUpdateFailure,
  pwaUpdateNotice,
  registerServiceWorker,
  requestPwaEngineRecovery,
  SERVICE_WORKER_URL,
} from '@/pwa';
import { readSource } from './helpers/source-text';

let removePreparation: (() => void) | null = null;

beforeEach(() => {
  dismissPwaUpdateNotice();
});

afterEach(() => {
  removePreparation?.();
  removePreparation = null;
});

describe('PWA registration', () => {
  it('registers the service worker only for production browser sessions', async () => {
    const register = vi.fn().mockResolvedValue({ scope: '/' });
    const navigator = { serviceWorker: { register } } as unknown as Navigator & {
      serviceWorker: ServiceWorkerContainer;
    };

    await expect(
      registerServiceWorker({
        environment: { PROD: true },
        location: { protocol: 'https:' },
        navigator,
      }),
    ).resolves.toEqual({ scope: '/' });
    expect(register).toHaveBeenCalledWith(SERVICE_WORKER_URL, { scope: '/' });
  });

  it('skips registration during development, file launches, and unsupported browsers', async () => {
    const register = vi.fn();
    const navigator = { serviceWorker: { register } } as unknown as Navigator & {
      serviceWorker: ServiceWorkerContainer;
    };

    expect(
      canRegisterServiceWorker({
        environment: { PROD: false },
        location: { protocol: 'https:' },
        navigator,
      }),
    ).toBe(false);
    expect(
      canRegisterServiceWorker({
        environment: { PROD: true },
        location: { protocol: 'file:' },
        navigator,
      }),
    ).toBe(false);
    expect(
      canRegisterServiceWorker({
        environment: { PROD: true },
        location: { protocol: 'https:' },
        navigator: {} as Navigator,
      }),
    ).toBe(false);

    await expect(
      registerServiceWorker({
        environment: { PROD: false },
        location: { protocol: 'https:' },
        navigator,
      }),
    ).resolves.toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it('announces an installed update and reloads after activating the waiting worker', async () => {
    const installing = Object.assign(new EventTarget(), { state: 'installing' });
    const waiting = { postMessage: vi.fn() };
    const registration = Object.assign(new EventTarget(), {
      scope: '/',
      installing,
      waiting: null as typeof waiting | null,
      update: vi.fn(async () => undefined),
    });
    const container = Object.assign(new EventTarget(), {
      controller: {},
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration),
    });
    const reload = vi.fn();
    await registerServiceWorker({
      environment: { PROD: true },
      location: { protocol: 'https:' },
      navigator: { serviceWorker: container } as unknown as Navigator,
      reload,
    });

    registration.dispatchEvent(new Event('updatefound'));
    registration.waiting = waiting;
    installing.state = 'installed';
    installing.dispatchEvent(new Event('statechange'));
    expect(pwaUpdateNotice.value).toBe('update');

    const prepare = vi.fn(async () => true);
    removePreparation = installPwaReloadPreparation(prepare);
    await applyPwaUpdateAndReload();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).not.toHaveBeenCalled();
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps the update notice and does not activate a worker when preparation fails', async () => {
    const waiting = { postMessage: vi.fn() };
    const registration = Object.assign(new EventTarget(), {
      scope: '/',
      installing: null,
      waiting,
      update: vi.fn(async () => undefined),
    });
    const container = Object.assign(new EventTarget(), {
      controller: {},
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration),
    });
    const reload = vi.fn();
    await registerServiceWorker({
      environment: { PROD: true },
      location: { protocol: 'https:' },
      navigator: { serviceWorker: container } as unknown as Navigator,
      reload,
    });
    requestPwaEngineRecovery();
    removePreparation = installPwaReloadPreparation(vi.fn(async () => false));

    await applyPwaUpdateAndReload();

    expect(pwaUpdateNotice.value).toBe('engine-version');
    expect(pwaUpdateFailure.value).toBe('autosave');
    expect(waiting.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps the update notice and does not reload when preparation throws', async () => {
    const registration = Object.assign(new EventTarget(), {
      scope: '/',
      installing: null,
      waiting: null,
      update: vi.fn(async () => undefined),
    });
    const container = Object.assign(new EventTarget(), {
      controller: {},
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration),
    });
    const reload = vi.fn();
    await registerServiceWorker({
      environment: { PROD: true },
      location: { protocol: 'https:' },
      navigator: { serviceWorker: container } as unknown as Navigator,
      reload,
    });
    requestPwaEngineRecovery();
    removePreparation = installPwaReloadPreparation(
      vi.fn(async () => {
        throw new Error('autosave unavailable');
      }),
    );

    await expect(applyPwaUpdateAndReload()).resolves.toBeUndefined();

    expect(pwaUpdateNotice.value).toBe('engine-version');
    expect(pwaUpdateFailure.value).toBe('autosave');
    expect(reload).not.toHaveBeenCalled();
  });

  it('offers the reload affordance when another client activates a release', async () => {
    const registration = Object.assign(new EventTarget(), {
      scope: '/',
      installing: null,
      waiting: null,
      update: vi.fn(async () => undefined),
    });
    const container = Object.assign(new EventTarget(), {
      controller: {},
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration),
    });
    const reload = vi.fn();
    await registerServiceWorker({
      environment: { PROD: true },
      location: { protocol: 'https:' },
      navigator: { serviceWorker: container } as unknown as Navigator,
      reload,
    });

    container.dispatchEvent(new Event('controllerchange'));

    expect(pwaUpdateNotice.value).toBe('update');
    expect(reload).not.toHaveBeenCalled();
  });

  it('clears app caches before an ABI recovery reload when no worker is waiting', async () => {
    const registration = Object.assign(new EventTarget(), {
      scope: '/',
      installing: null,
      waiting: null,
      update: vi.fn(async () => undefined),
      unregister: vi.fn(async () => true),
    });
    const container = Object.assign(new EventTarget(), {
      controller: {},
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration),
    });
    const cacheStorage = {
      keys: vi.fn(async () => ['sonare-studio-v1', 'unrelated-cache']),
      delete: vi.fn(async () => true),
    } as unknown as CacheStorage;
    const reload = vi.fn();
    await registerServiceWorker({
      environment: { PROD: true },
      location: { protocol: 'https:' },
      navigator: { serviceWorker: container } as unknown as Navigator,
      reload,
      cacheStorage,
    });

    requestPwaEngineRecovery();
    expect(pwaUpdateNotice.value).toBe('engine-version');
    await applyPwaUpdateAndReload();

    expect(cacheStorage.delete).toHaveBeenCalledWith('sonare-studio-v1');
    expect(cacheStorage.delete).not.toHaveBeenCalledWith('unrelated-cache');
    // The emptied worker must go too, or it refills its release cache one
    // opportunistic response at a time and mixes releases.
    expect(registration.unregister).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('offers the reload affordance when a chunk of this build is no longer served', async () => {
    const target = new EventTarget();
    const stop = observeMissingChunks(target);

    const event = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(event);

    expect(pwaUpdateNotice.value).toBe('missing-asset');
    // Vite rethrows the import rejection unless the event is cancelled.
    expect(event.defaultPrevented).toBe(true);

    stop();
    dismissPwaUpdateNotice();
    target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    expect(pwaUpdateNotice.value).toBeNull();
  });
});

describe('PWA assets', () => {
  it('declares installable standalone app metadata', async () => {
    const manifest = JSON.parse(readSource('public/manifest.webmanifest')) as {
      id: string;
      display: string;
      start_url: string;
      scope: string;
      icons: Array<{ purpose: string; sizes: string; src: string; type: string }>;
      file_handlers: Array<{ action: string; accept: Record<string, string[]> }>;
    };

    expect(manifest.id).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.icons).toContainEqual({
      src: '/icon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any maskable',
    });
    expect(manifest.icons).toContainEqual({
      src: '/icon-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any maskable',
    });
    expect(manifest.icons).toContainEqual({
      src: '/icon-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any maskable',
    });
    expect(manifest.file_handlers).toContainEqual({
      action: '/',
      accept: { 'application/x-sonare-studio': ['.szd'] },
    });
  });

  it('recovers a shell that cannot load its entry module without a forced reload', async () => {
    const document = readSource('index.html');

    expect(document).toContain("const MARKER = 'sonare-shell-recovery'");
    // Resource load errors do not bubble, so the listener must capture.
    expect(document).toContain("addEventListener(\n          'error',");
    expect(document).toContain("target.tagName !== 'SCRIPT' && target.tagName !== 'LINK'");
    expect(document).toContain("key.indexOf('sonare-studio-') === 0");
    expect(document).toContain('registration.unregister()');
    expect(document).toContain('location.reload()');
    // The build hoists the entry module and the stylesheet into <head>, so the
    // guard only sees their load failures while it stays the first script and
    // link of the document.
    const guard = document.indexOf('sonare-shell-recovery');
    const headEnd = document.indexOf('</head>');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(headEnd).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(headEnd);
    const tags = [...document.matchAll(/<(?:script|link)\b/g)].map((match) => match.index);
    expect(guard).toBeGreaterThan(tags[0]);
    expect(guard).toBeLessThan(tags[1]);
  });

  it('builds a content-addressed AudioWorklet and injects its URL into the app bundle', async () => {
    const workletConfig = readSource('vite.worklet.config.ts');
    const appConfig = readSource('vite.config.ts');
    const engine = readSource('src/engine/engine.ts');

    expect(workletConfig).toContain("WORKLET_ASSET_PREFIX = 'sonare-engine-worklet-'");
    expect(workletConfig).toContain('[hash].js');
    expect(workletConfig).toContain('worklet-manifest.json');
    expect(appConfig).toContain('__SONARE_WORKLET_MODULE_URL__');
    expect(appConfig).toContain("name: 'pwa-precache-manifest'");
    expect(appConfig).toContain("fileName: 'precache-manifest.json'");
    expect(appConfig).toContain('hashBuildValue(hash, serviceWorkerTemplate)');
    expect(appConfig).toContain("writeFileSync(resolve(options.dir ?? 'dist', 'sw.js')");
    expect(engine).toContain("typeof __SONARE_WORKLET_MODULE_URL__ === 'string'");
    expect(engine).not.toContain("WORKLET_MODULE_URL = '/sonare-engine-worklet.js'");
  });

  it('serves content-addressed assets immutably and the release contract revalidated', async () => {
    const headers = readSource('public/_headers');
    const rules = new Map<string, Record<string, string>>();
    let path = '';
    for (const line of headers.split('\n')) {
      if (line.startsWith('#') || line.trim() === '') continue;
      if (!line.startsWith(' ')) {
        path = line.trim();
        if (!rules.has(path)) rules.set(path, {});
        continue;
      }
      const separator = line.indexOf(':');
      const rule = rules.get(path);
      if (rule) rule[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }

    expect(rules.get('/assets/*')?.['Cache-Control']).toBe('public, max-age=31536000, immutable');
    // A rule matches the requested path rather than the file the host resolves
    // it to, so both the canonical document and a legacy direct request stay
    // revalidated while the Service Worker uses `/` as its shell key.
    for (const revalidated of [
      '/sw.js',
      '/precache-manifest.json',
      '/worklet-manifest.json',
      '/',
      '/index.html',
    ]) {
      expect(rules.get(revalidated)?.['Cache-Control']).toBe('no-cache');
    }
    // Cloudflare Pages applies every matching rule, so a Cache-Control on the
    // catch-all would combine with the immutable one rather than lose to it.
    expect(rules.get('/*')?.['Cache-Control']).toBeUndefined();
  });
});

class SwHeaders {
  constructor(private readonly entries: Record<string, string> = {}) {}

  get(name: string): string | null {
    return this.entries[name.toLowerCase()] ?? null;
  }

  forEach(callback: (value: string, name: string) => void): void {
    for (const [name, value] of Object.entries(this.entries)) callback(value, name);
  }
}

class SwResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly type = 'basic';
  readonly headers: SwHeaders;
  readonly redirected: boolean;

  constructor(
    readonly body: string,
    status = 200,
    private readonly headerEntries: Record<string, string> = {},
    options: { redirected?: boolean } = {},
  ) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.headers = new SwHeaders(headerEntries);
    this.redirected = options.redirected ?? false;
  }

  clone(): SwResponse {
    return new SwResponse(this.body, this.status, this.headerEntries, {
      redirected: this.redirected,
    });
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.body);
  }
}

/** The `Response` constructor the worker synthesizes its own answers with. */
class SwSynthesizedResponse extends SwResponse {
  constructor(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
    super(body, init.status ?? 200, init.headers ?? {});
  }
}

/** The app document answering under an asset URL, as a stale path does on the host. */
function shellFallbackResponse(): SwResponse {
  return new SwResponse('<!doctype html><html></html>', 200, {
    'content-type': 'text/html; charset=utf-8',
  });
}

function releaseResponse(body: string, path: string): SwResponse {
  return path === '/'
    ? new SwResponse(body, 200, { 'content-type': 'text/html; charset=utf-8' })
    : new SwResponse(body);
}

class SwRequest {
  readonly url: string;
  readonly method = 'GET';
  readonly mode: string;
  readonly headers = { has: () => false };

  constructor(input: string | SwRequest, init: { mode?: string } = {}) {
    this.url = new URL(typeof input === 'string' ? input : input.url, 'https://app.test').href;
    this.mode = init.mode ?? (typeof input === 'string' ? 'cors' : input.mode);
  }
}

function cacheKey(input: string | SwRequest): string {
  return new URL(typeof input === 'string' ? input : input.url, 'https://app.test').pathname;
}

class SwCache {
  readonly entries = new Map<string, SwResponse>();

  constructor(private readonly fetcher: (request: SwRequest) => Promise<SwResponse>) {}

  async addAll(requests: SwRequest[]): Promise<void> {
    const staged: Array<[string, SwResponse]> = [];
    for (const request of requests) {
      const response = await this.fetcher(request);
      if (!response.ok) throw new Error(`Fetch failed: ${request.url}`);
      staged.push([cacheKey(request), response.clone()]);
    }
    for (const [key, response] of staged) this.entries.set(key, response);
  }

  async put(request: string | SwRequest, response: SwResponse): Promise<void> {
    this.entries.set(cacheKey(request), response.clone());
  }

  async match(request: string | SwRequest): Promise<SwResponse | undefined> {
    return this.entries.get(cacheKey(request))?.clone();
  }
}

class SwCacheStorage {
  readonly stores = new Map<string, SwCache>();

  constructor(private readonly fetcher: (request: SwRequest) => Promise<SwResponse>) {}

  async open(name: string): Promise<SwCache> {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new SwCache(this.fetcher);
      this.stores.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
}

interface SwHarness {
  activate(): Promise<void>;
  fetch(path: string, mode?: string): Promise<SwResponse | undefined>;
  install(): Promise<void>;
}

function evaluateServiceWorker(
  source: string,
  cacheStorage: SwCacheStorage,
  fetcher: (request: SwRequest) => Promise<SwResponse>,
): SwHarness {
  const listeners = new Map<string, (event: never) => void>();
  const self = {
    location: { origin: 'https://app.test' },
    clients: { claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(),
    addEventListener: (type: string, listener: (event: never) => void) => {
      listeners.set(type, listener);
    },
  };
  Function(
    'self',
    'caches',
    'fetch',
    'Request',
    'Response',
    'URL',
    source,
  )(self, cacheStorage, fetcher, SwRequest, SwSynthesizedResponse, URL);
  const lifecycle = async (type: 'install' | 'activate'): Promise<void> => {
    let pending: Promise<unknown> | undefined;
    listeners.get(type)?.({ waitUntil: (value: Promise<unknown>) => (pending = value) } as never);
    await pending;
  };
  return {
    install: () => lifecycle('install'),
    activate: () => lifecycle('activate'),
    fetch: async (path, mode = 'cors') => {
      let pending: Promise<SwResponse | undefined> | undefined;
      listeners.get('fetch')?.({
        request: new SwRequest(path, { mode }),
        respondWith: (value: Promise<SwResponse | undefined>) => (pending = value),
      } as never);
      return pending;
    },
  };
}

function releaseManifest(release: string): { assets: string[]; cacheVersion: string } {
  return {
    cacheVersion: `sonare-studio-${release}`,
    assets: [
      '/',
      '/manifest.webmanifest',
      '/worklet-manifest.json',
      `/assets/app-${release}.css`,
      `/assets/app-${release}.js`,
      `/assets/sonare-engine-worklet-${release}.js`,
      '/precache-manifest.json',
    ],
  };
}

describe('Service Worker release isolation', () => {
  it('starts offline after the first install with every generated bundle class cached', async () => {
    const template = readSource('public/sw.js');
    const manifest = releaseManifest('a');
    let online = true;
    const fetcher = async (request: SwRequest): Promise<SwResponse> => {
      if (!online) throw new Error('offline');
      const path = cacheKey(request);
      if (path === '/precache-manifest.json') return new SwResponse(JSON.stringify(manifest));
      return releaseResponse(`release-a:${path}`, path);
    };
    const caches = new SwCacheStorage(fetcher);
    const worker = evaluateServiceWorker(
      template.replaceAll('__SONARE_CACHE_VERSION__', manifest.cacheVersion),
      caches,
      fetcher,
    );

    await worker.install();
    await worker.activate();
    online = false;

    await expect(worker.fetch('/anything', 'navigate')).resolves.toMatchObject({
      body: 'release-a:/',
    });
    const cache = caches.stores.get(manifest.cacheVersion);
    expect([...cache!.entries.keys()].sort()).toEqual([...manifest.assets].sort());
  });

  it('normalizes Cloudflare document redirects before caching and serving the shell', async () => {
    const template = readSource('public/sw.js');
    const manifest = releaseManifest('redirected');
    manifest.assets.push('/index.html');
    const fetcher = async (request: SwRequest): Promise<SwResponse> => {
      const path = cacheKey(request);
      if (path === '/precache-manifest.json') return new SwResponse(JSON.stringify(manifest));
      if (path === '/' || path === '/index.html') {
        return new SwResponse(
          '<!doctype html><html><body>shell</body></html>',
          200,
          {
            'content-type': 'text/html; charset=utf-8',
            location: 'https://app.test/',
            'content-length': '48',
            'cross-origin-opener-policy': 'same-origin',
          },
          { redirected: true },
        );
      }
      return new SwResponse(`asset:${path}`);
    };
    const caches = new SwCacheStorage(fetcher);
    const worker = evaluateServiceWorker(
      template.replaceAll('__SONARE_CACHE_VERSION__', manifest.cacheVersion),
      caches,
      fetcher,
    );

    await worker.install();
    await worker.activate();

    const cache = caches.stores.get(manifest.cacheVersion)!;
    const shell = cache.entries.get('/');
    expect(shell).toMatchObject({ body: '<!doctype html><html><body>shell</body></html>' });
    expect(shell?.redirected).toBe(false);
    expect(shell?.headers.get('location')).toBeNull();
    expect(shell?.headers.get('content-length')).toBeNull();
    expect(shell?.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(cache.entries.has('/index.html')).toBe(false);

    await expect(worker.fetch('/project', 'navigate')).resolves.toMatchObject({
      body: '<!doctype html><html><body>shell</body></html>',
      redirected: false,
    });
  });

  it('normalizes a redirected live shell when the release manifest is unavailable', async () => {
    const template = readSource('public/sw.js');
    const fetcher = async (request: SwRequest): Promise<SwResponse> => {
      const path = cacheKey(request);
      if (path === '/precache-manifest.json') return new SwResponse('offline', 503);
      if (path === '/') {
        return new SwResponse(
          '<html>live shell</html>',
          200,
          {
            location: 'https://app.test/',
            'content-type': 'text/html; charset=utf-8',
          },
          { redirected: true },
        );
      }
      return new SwResponse(`asset:${path}`);
    };
    const caches = new SwCacheStorage(fetcher);
    const worker = evaluateServiceWorker(
      template.replaceAll('__SONARE_CACHE_VERSION__', 'sonare-studio-live'),
      caches,
      fetcher,
    );

    await expect(worker.fetch('/project', 'navigate')).resolves.toMatchObject({
      body: '<html>live shell</html>',
      redirected: false,
    });
  });

  it('rejects a JavaScript response under the canonical shell key', async () => {
    const template = readSource('public/sw.js');
    const manifest = releaseManifest('wrong-content');
    const fetcher = async (request: SwRequest): Promise<SwResponse> => {
      const path = cacheKey(request);
      if (path === '/precache-manifest.json') return new SwResponse(JSON.stringify(manifest));
      if (path === '/') {
        return new SwResponse('window.notTheShell = true;', 200, {
          'content-type': 'text/javascript; charset=utf-8',
        });
      }
      return new SwResponse(`asset:${path}`);
    };
    const caches = new SwCacheStorage(fetcher);
    const worker = evaluateServiceWorker(
      template.replaceAll('__SONARE_CACHE_VERSION__', manifest.cacheVersion),
      caches,
      fetcher,
    );

    await expect(worker.install()).rejects.toThrow('without an HTML shell: /');
    expect(await caches.keys()).toEqual([]);
  });

  it('repairs a legacy active cache before a new worker can activate', async () => {
    const template = readSource('public/sw.js');
    const manifest = releaseManifest('new');
    const fetcher = async (request: SwRequest): Promise<SwResponse> => {
      const path = cacheKey(request);
      if (path === '/precache-manifest.json') return new SwResponse(JSON.stringify(manifest));
      return releaseResponse(`release-new:${path}`, path);
    };
    const caches = new SwCacheStorage(fetcher);
    const oldCache = await caches.open('sonare-studio-old');
    await oldCache.put(
      '/',
      new SwResponse(
        '<html>root shell</html>',
        200,
        {
          'content-type': 'text/html; charset=utf-8',
          location: 'https://app.test/',
        },
        { redirected: true },
      ),
    );
    await oldCache.put(
      '/index.html',
      new SwResponse(
        '<html>old shell</html>',
        200,
        {
          'content-type': 'text/html; charset=utf-8',
          location: 'https://app.test/',
        },
        { redirected: true },
      ),
    );
    const worker = evaluateServiceWorker(
      template.replaceAll('__SONARE_CACHE_VERSION__', manifest.cacheVersion),
      caches,
      fetcher,
    );

    await worker.install();

    const migrated = caches.stores.get('sonare-studio-old')!;
    expect(migrated.entries.get('/index.html')?.redirected).toBe(false);
    expect(migrated.entries.get('/index.html')?.body).toBe('<html>old shell</html>');
    expect(migrated.entries.get('/index.html')?.headers.get('location')).toBeNull();
    expect(migrated.entries.get('/')?.body).toBe('<html>root shell</html>');
    expect(migrated.entries.get('/')?.redirected).toBe(false);
    expect(migrated.entries.get('/')?.headers.get('location')).toBeNull();
    expect(await caches.keys()).toContain('sonare-studio-old');
  });

  it('keeps the active release intact through failed and waiting updates', async () => {
    const template = readSource('public/sw.js');
    const manifestA = releaseManifest('a');
    const manifestB = releaseManifest('b');
    let activeManifest = manifestA;
    let failB = false;
    let online = true;
    const fetcher = async (request: SwRequest): Promise<SwResponse> => {
      if (!online) throw new Error('offline');
      const path = cacheKey(request);
      if (path === '/precache-manifest.json') {
        return new SwResponse(JSON.stringify(activeManifest));
      }
      if (failB && path === '/assets/app-b.js') throw new Error('partial deploy');
      const release = path.includes('-b.') ? 'b' : activeManifest === manifestB ? 'b' : 'a';
      return releaseResponse(`release-${release}:${path}`, path);
    };
    const caches = new SwCacheStorage(fetcher);
    const workerA = evaluateServiceWorker(
      template.replaceAll('__SONARE_CACHE_VERSION__', manifestA.cacheVersion),
      caches,
      fetcher,
    );
    await workerA.install();
    await workerA.activate();

    activeManifest = manifestB;
    failB = true;
    const failedB = evaluateServiceWorker(
      template.replaceAll('__SONARE_CACHE_VERSION__', manifestB.cacheVersion),
      caches,
      fetcher,
    );
    await expect(failedB.install()).rejects.toThrow('partial deploy');
    expect(await caches.keys()).toEqual([manifestA.cacheVersion]);

    failB = false;
    const waitingB = evaluateServiceWorker(
      template.replaceAll('__SONARE_CACHE_VERSION__', manifestB.cacheVersion),
      caches,
      fetcher,
    );
    await waitingB.install();
    expect((await caches.keys()).sort()).toEqual(
      [manifestA.cacheVersion, manifestB.cacheVersion].sort(),
    );

    online = false;
    await expect(workerA.fetch('/next', 'navigate')).resolves.toMatchObject({
      body: 'release-a:/',
    });
    await expect(workerA.fetch('/assets/app-b.js')).rejects.toThrow('offline');

    await waitingB.activate();
    expect(await caches.keys()).toEqual([manifestB.cacheVersion]);
    await expect(waitingB.fetch('/next', 'navigate')).resolves.toMatchObject({
      body: 'release-b:/',
    });
  });

  it('repairs a release cache that lost its shell instead of pinning one document', async () => {
    const template = readSource('public/sw.js');
    const manifest = releaseManifest('a');
    const fetcher = async (request: SwRequest): Promise<SwResponse> => {
      const path = cacheKey(request);
      if (path === '/precache-manifest.json') return new SwResponse(JSON.stringify(manifest));
      return releaseResponse(`release-a:${path}`, path);
    };
    const caches = new SwCacheStorage(fetcher);
    const worker = evaluateServiceWorker(
      template.replaceAll('__SONARE_CACHE_VERSION__', manifest.cacheVersion),
      caches,
      fetcher,
    );
    await worker.install();
    await worker.activate();

    // Storage eviction, or the in-app recovery clear, can empty the cache of a
    // worker that stays active.
    caches.stores.delete(manifest.cacheVersion);

    await expect(worker.fetch('/anything', 'navigate')).resolves.toMatchObject({
      body: 'release-a:/',
    });
    const repaired = caches.stores.get(manifest.cacheVersion);
    expect([...repaired!.entries.keys()].sort()).toEqual([...manifest.assets].sort());
  });

  it('admits only content-addressed assets into the release cache on a miss', async () => {
    const template = readSource('public/sw.js');
    const manifest = releaseManifest('a');
    const fetcher = async (request: SwRequest): Promise<SwResponse> => {
      const path = cacheKey(request);
      if (path === '/precache-manifest.json') return new SwResponse(JSON.stringify(manifest));
      return releaseResponse(`release-a:${path}`, path);
    };
    const caches = new SwCacheStorage(fetcher);
    const worker = evaluateServiceWorker(
      template.replaceAll('__SONARE_CACHE_VERSION__', manifest.cacheVersion),
      caches,
      fetcher,
    );
    await worker.install();
    await worker.activate();
    const cache = caches.stores.get(manifest.cacheVersion);

    await expect(worker.fetch('/late-icon.svg')).resolves.toMatchObject({
      body: 'release-a:/late-icon.svg',
    });
    expect(cache!.entries.has('/late-icon.svg')).toBe(false);

    await expect(worker.fetch('/assets/late-a.js')).resolves.toMatchObject({
      body: 'release-a:/assets/late-a.js',
    });
    expect(cache!.entries.has('/assets/late-a.js')).toBe(true);
  });

  it('refuses to install a release whose assets answer with the app shell', async () => {
    const template = readSource('public/sw.js');
    const manifestA = releaseManifest('a');
    const manifestB = releaseManifest('b');
    let activeManifest = manifestA;
    // An edge that has not caught up with the deploy rewrites the asset onto
    // the document instead of serving it — a 200, not a 404.
    let staleEdge = false;
    const fetcher = async (request: SwRequest): Promise<SwResponse> => {
      const path = cacheKey(request);
      if (path === '/precache-manifest.json') return new SwResponse(JSON.stringify(activeManifest));
      if (staleEdge && path === '/assets/app-b.js') return shellFallbackResponse();
      return releaseResponse(`release-${activeManifest === manifestB ? 'b' : 'a'}:${path}`, path);
    };
    const caches = new SwCacheStorage(fetcher);
    const workerA = evaluateServiceWorker(
      template.replaceAll('__SONARE_CACHE_VERSION__', manifestA.cacheVersion),
      caches,
      fetcher,
    );
    await workerA.install();
    await workerA.activate();

    activeManifest = manifestB;
    staleEdge = true;
    const workerB = evaluateServiceWorker(
      template.replaceAll('__SONARE_CACHE_VERSION__', manifestB.cacheVersion),
      caches,
      fetcher,
    );
    await expect(workerB.install()).rejects.toThrow('answered with the app shell');
    // The half-deployed release leaves no cache behind, so the running one keeps
    // serving until an install actually succeeds.
    expect(await caches.keys()).toEqual([manifestA.cacheVersion]);

    staleEdge = false;
    await workerB.install();
    await workerB.activate();
    expect(
      caches.stores.get(manifestB.cacheVersion)?.entries.get('/assets/app-b.js'),
    ).toMatchObject({ body: 'release-b:/assets/app-b.js' });
  });

  it('answers a stale asset with 404 rather than caching the app shell under its URL', async () => {
    const template = readSource('public/sw.js');
    const manifest = releaseManifest('a');
    const fetcher = async (request: SwRequest): Promise<SwResponse> => {
      const path = cacheKey(request);
      if (path === '/precache-manifest.json') return new SwResponse(JSON.stringify(manifest));
      if (path.startsWith('/assets/gone-')) return shellFallbackResponse();
      return releaseResponse(`release-a:${path}`, path);
    };
    const caches = new SwCacheStorage(fetcher);
    const worker = evaluateServiceWorker(
      template.replaceAll('__SONARE_CACHE_VERSION__', manifest.cacheVersion),
      caches,
      fetcher,
    );
    await worker.install();
    await worker.activate();

    await expect(worker.fetch('/assets/gone-a.js')).resolves.toMatchObject({ status: 404 });
    expect(caches.stores.get(manifest.cacheVersion)?.entries.has('/assets/gone-a.js')).toBe(false);
    // A repeat load must fail the same way instead of finding a cached document.
    await expect(worker.fetch('/assets/gone-a.js')).resolves.toMatchObject({ status: 404 });
    // The document itself is still the app shell and must stay servable.
    await expect(worker.fetch('/anything', 'navigate')).resolves.toMatchObject({
      body: 'release-a:/',
    });
  });

  it('answers with a recovery document instead of failing the navigation outright', async () => {
    const template = readSource('public/sw.js');
    const manifest = releaseManifest('a');
    let online = true;
    const fetcher = async (request: SwRequest): Promise<SwResponse> => {
      if (!online) throw new Error('offline');
      const path = cacheKey(request);
      if (path === '/precache-manifest.json') return new SwResponse(JSON.stringify(manifest));
      return releaseResponse(`release-a:${path}`, path);
    };
    const caches = new SwCacheStorage(fetcher);
    const worker = evaluateServiceWorker(
      template.replaceAll('__SONARE_CACHE_VERSION__', manifest.cacheVersion),
      caches,
      fetcher,
    );
    await worker.install();
    await worker.activate();

    caches.stores.delete(manifest.cacheVersion);
    online = false;

    const response = await worker.fetch('/anything', 'navigate');
    expect(response?.status).toBe(503);
    expect(response?.body).toContain('id="retry"');
    expect(response?.body).toContain("key.indexOf('sonare-studio-') === 0");

    // An uncacheable request must resolve too: an undefined response would fail
    // at the browser level rather than as one the app can report.
    await expect(worker.fetch('/somewhere/else.txt')).resolves.toMatchObject({ status: 504 });
  });

  it('returns a live shell when Cache Storage cannot be opened', async () => {
    const template = readSource('public/sw.js');
    const fetcher = async (request: SwRequest): Promise<SwResponse> => {
      const path = cacheKey(request);
      if (path === '/precache-manifest.json') return new SwResponse('unavailable', 503);
      if (path === '/') return releaseResponse('<html>live shell</html>', path);
      return new SwResponse(`asset:${path}`);
    };
    const cacheStorage = {
      open: vi.fn(async () => {
        throw new Error('Cache Storage unavailable');
      }),
      keys: vi.fn(async () => []),
      delete: vi.fn(async () => true),
    } as unknown as SwCacheStorage;
    const worker = evaluateServiceWorker(
      template.replaceAll('__SONARE_CACHE_VERSION__', 'sonare-studio-cache-open-failure'),
      cacheStorage,
      fetcher,
    );

    await expect(worker.fetch('/project', 'navigate')).resolves.toMatchObject({
      body: '<html>live shell</html>',
      status: 200,
    });
  });

  it('returns a normalized cached shell when cache repair cannot be written', async () => {
    const template = readSource('public/sw.js');
    const fetcher = async (request: SwRequest): Promise<SwResponse> => {
      const path = cacheKey(request);
      if (path === '/') {
        return new SwResponse(
          '<html>cached shell</html>',
          200,
          {
            'content-type': 'text/html; charset=utf-8',
            location: 'https://app.test/',
          },
          { redirected: true },
        );
      }
      return new SwResponse(`asset:${path}`);
    };
    const cache = new SwCache(fetcher);
    cache.entries.set(
      '/',
      new SwResponse(
        '<html>cached shell</html>',
        200,
        {
          'content-type': 'text/html; charset=utf-8',
          location: 'https://app.test/',
        },
        { redirected: true },
      ),
    );
    cache.put = vi.fn(async () => {
      throw new Error('quota exceeded');
    });
    const cacheStorage = {
      open: vi.fn(async () => cache),
      keys: vi.fn(async () => ['sonare-studio-cache-write-failure']),
      delete: vi.fn(async () => true),
    } as unknown as SwCacheStorage;
    const worker = evaluateServiceWorker(
      template.replaceAll('__SONARE_CACHE_VERSION__', 'sonare-studio-cache-write-failure'),
      cacheStorage,
      fetcher,
    );

    await expect(worker.fetch('/project', 'navigate')).resolves.toMatchObject({
      body: '<html>cached shell</html>',
      redirected: false,
      status: 200,
    });
  });
});
