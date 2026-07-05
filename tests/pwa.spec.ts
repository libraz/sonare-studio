import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canRegisterServiceWorker, registerServiceWorker, SERVICE_WORKER_URL } from '@/pwa';

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

    expect(serviceWorker).toContain(
      "const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg']",
    );
    expect(serviceWorker).toContain("request.mode === 'navigate'");
    expect(serviceWorker).toContain("caches.match('/index.html')");
    expect(serviceWorker).toContain('caches.delete(key)');
  });
});
