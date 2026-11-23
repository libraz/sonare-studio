import { vi } from 'vitest';

/**
 * In-memory Service Worker harness: evaluates public/sw.js against fake Cache
 * Storage, Request and Response so install, activate and fetch run in a test.
 */

export class SwHeaders {
  constructor(private readonly entries: Record<string, string> = {}) {}

  get(name: string): string | null {
    return this.entries[name.toLowerCase()] ?? null;
  }

  forEach(callback: (value: string, name: string) => void): void {
    for (const [name, value] of Object.entries(this.entries)) callback(value, name);
  }
}

export class SwResponse {
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
export class SwSynthesizedResponse extends SwResponse {
  constructor(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
    super(body, init.status ?? 200, init.headers ?? {});
  }
}

/** The app document answering under an asset URL, as a stale path does on the host. */
export function shellFallbackResponse(): SwResponse {
  return new SwResponse('<!doctype html><html></html>', 200, {
    'content-type': 'text/html; charset=utf-8',
  });
}

export function releaseResponse(body: string, path: string): SwResponse {
  return path === '/'
    ? new SwResponse(body, 200, { 'content-type': 'text/html; charset=utf-8' })
    : new SwResponse(body);
}

export class SwRequest {
  readonly url: string;
  readonly method = 'GET';
  readonly mode: string;
  readonly headers = { has: () => false };

  constructor(input: string | SwRequest, init: { mode?: string } = {}) {
    this.url = new URL(typeof input === 'string' ? input : input.url, 'https://app.test').href;
    this.mode = init.mode ?? (typeof input === 'string' ? 'cors' : input.mode);
  }
}

export function cacheKey(input: string | SwRequest): string {
  return new URL(typeof input === 'string' ? input : input.url, 'https://app.test').pathname;
}

export class SwCache {
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

export class SwCacheStorage {
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

  async has(name: string): Promise<boolean> {
    return this.stores.has(name);
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
}

export interface SwHarness {
  activate(): Promise<void>;
  fetch(path: string, mode?: string): Promise<SwResponse | undefined>;
  install(): Promise<void>;
}

export function evaluateServiceWorker(
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

export function releaseManifest(release: string): { assets: string[]; cacheVersion: string } {
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
