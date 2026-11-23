import { describe, expect, it } from 'vitest';
import {
  cacheKey,
  evaluateServiceWorker,
  releaseManifest,
  releaseResponse,
  SwCacheStorage,
  type SwRequest,
  SwResponse,
} from './helpers/service-worker';
import { readSource } from './helpers/source-text';

describe('Service Worker shell repair', () => {
  it('keeps the active release cache when repairing an evicted shell fails', async () => {
    const manifest = releaseManifest('a');
    let deployMovedOn = false;
    const fetcher = async (request: SwRequest): Promise<SwResponse> => {
      const path = cacheKey(request);
      if (path === '/precache-manifest.json') return new SwResponse(JSON.stringify(manifest));
      // After a newer deploy, this release's hashed bundles are gone from the host.
      if (deployMovedOn && path.startsWith('/assets/')) return new SwResponse('gone', 404);
      return releaseResponse(`release-a:${path}`, path);
    };
    const caches = new SwCacheStorage(fetcher);
    const worker = evaluateServiceWorker(
      readSource('public/sw.js').replaceAll('__SONARE_CACHE_VERSION__', manifest.cacheVersion),
      caches,
      fetcher,
    );
    await worker.install();
    await worker.activate();

    const cache = caches.stores.get(manifest.cacheVersion)!;
    cache.entries.delete('/');
    deployMovedOn = true;

    await expect(worker.fetch('/project', 'navigate')).resolves.toMatchObject({
      body: 'release-a:/',
    });
    expect(caches.stores.get(manifest.cacheVersion)).toBe(cache);
    await expect(worker.fetch('/assets/app-a.js')).resolves.toMatchObject({
      body: 'release-a:/assets/app-a.js',
    });
  });
});
