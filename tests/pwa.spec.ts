import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPwaUpdateAndReload,
  canRegisterServiceWorker,
  dismissPwaUpdateNotice,
  pwaUpdateNotice,
  registerServiceWorker,
  requestPwaEngineRecovery,
  SERVICE_WORKER_URL,
} from '@/pwa';

beforeEach(() => {
  dismissPwaUpdateNotice();
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

    await applyPwaUpdateAndReload();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).not.toHaveBeenCalled();
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('clears app caches before an ABI recovery reload when no worker is waiting', async () => {
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
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('PWA assets', () => {
  it('declares installable standalone app metadata', async () => {
    const manifestPath = resolve(process.cwd(), 'public/manifest.webmanifest');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      display: string;
      start_url: string;
      scope: string;
      icons: Array<{ purpose: string; sizes: string; src: string; type: string }>;
    };

    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.icons).toContainEqual({
      src: '/icon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any maskable',
    });
  });

  it('pre-caches the app shell and handles navigation fallbacks', async () => {
    const serviceWorker = await readFile(resolve(process.cwd(), 'public/sw.js'), 'utf8');

    expect(serviceWorker).toContain("'/worklet-manifest.json'");
    expect(serviceWorker).toContain(
      "workletManifest.moduleUrl.startsWith('/assets/sonare-engine-worklet-')",
    );
    expect(serviceWorker).toContain("event.data?.type === 'SKIP_WAITING'");
    expect(serviceWorker).toContain("request.mode === 'navigate'");
    expect(serviceWorker).toContain("caches.match('/index.html')");
    expect(serviceWorker).toContain('caches.delete(key)');
  });

  it('builds a content-addressed AudioWorklet and injects its URL into the app bundle', async () => {
    const workletConfig = await readFile(resolve(process.cwd(), 'vite.worklet.config.ts'), 'utf8');
    const appConfig = await readFile(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    const engine = await readFile(resolve(process.cwd(), 'src/engine/engine.ts'), 'utf8');

    expect(workletConfig).toContain("WORKLET_ASSET_PREFIX = 'sonare-engine-worklet-'");
    expect(workletConfig).toContain('[hash].js');
    expect(workletConfig).toContain('worklet-manifest.json');
    expect(appConfig).toContain('__SONARE_WORKLET_MODULE_URL__');
    expect(engine).toContain("typeof __SONARE_WORKLET_MODULE_URL__ === 'string'");
    expect(engine).not.toContain("WORKLET_MODULE_URL = '/sonare-engine-worklet.js'");
  });
});
