import { fileURLToPath } from 'node:url';
import { openFreshPage } from '../fresh-page.mjs';
import { createPagesServer } from '../pages-server.mjs';

const E2E_DIST = fileURLToPath(new URL('../../../.e2e-dist', import.meta.url));

/**
 * PWA: the build registers its service worker, precaches the whole release,
 * advertises an installable web app manifest, and — once the worker controls
 * the page — boots from its cache and opens the demo with the network cut.
 * Runs in its own browser context, which is the only way to start with no
 * worker installed, against the build served with the static host's headers:
 * the preview server adds `Vary: Origin`, which the host does not send.
 */
export const name = 'pwa-offline';

export async function run(ctx) {
  const { page: sharedPage, fail } = ctx;
  const server = await createPagesServer({ dist: E2E_DIST });
  const { baseUrl } = server;
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.locator('[data-testid="start-demo"]').waitFor({ state: 'visible', timeout: 30000 });

    // Registration: the worker installs, precaches the release and activates.
    const registered = await page
      .evaluate(async () => {
        const deadline = (ms) => new Promise((resolve) => setTimeout(() => resolve(null), ms));
        const registration = await Promise.race([navigator.serviceWorker.ready, deadline(60000)]);
        const worker = registration?.active;
        if (!worker) return null;
        if (worker.state !== 'activated') {
          await Promise.race([
            new Promise((resolve) =>
              worker.addEventListener(
                'statechange',
                () => worker.state === 'activated' && resolve(),
              ),
            ),
            deadline(60000),
          ]);
        }
        return { scope: registration.scope, state: worker.state };
      })
      .catch(() => null);
    if (registered?.state !== 'activated') {
      fail(`the service worker never activated: ${JSON.stringify(registered)}`);
      return;
    }
    console.info(`service worker active, scope ${registered.scope}`);
    const precache = await page.evaluate(async () => {
      const keys = (await globalThis.caches.keys()).filter((key) =>
        key.startsWith('sonare-studio-'),
      );
      const cache = keys.length > 0 ? await globalThis.caches.open(keys[0]) : null;
      const cached = cache ? (await cache.keys()).map((entry) => new URL(entry.url).pathname) : [];
      const manifest = await (await fetch('/precache-manifest.json', { cache: 'no-store' })).json();
      return {
        keys,
        listed: manifest.assets.length,
        missing: manifest.assets.filter((asset) => !cached.includes(asset)),
      };
    });
    if (precache.keys.length !== 1 || precache.listed < 5 || precache.missing.length > 0) {
      fail(`the release was not fully precached: ${JSON.stringify(precache)}`);
    }

    // Installability: a manifest the browser can act on.
    const manifest = await page.evaluate(async () => {
      const href = document.querySelector('link[rel="manifest"]')?.getAttribute('href');
      if (!href) return null;
      const response = await fetch(href);
      return response.ok ? response.json() : null;
    });
    const sizes = (manifest?.icons ?? []).map((icon) => icon.sizes);
    if (
      manifest?.display !== 'standalone' ||
      manifest.start_url !== '/' ||
      !sizes.includes('192x192') ||
      !sizes.includes('512x512')
    ) {
      fail(`the web app manifest is not installable: ${JSON.stringify(manifest)}`);
    }

    // The first load is not necessarily controlled; one online reload settles that.
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
      timeout: 15000,
    });

    await context.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    await page.locator('[data-testid="start-demo"]').waitFor({ state: 'visible', timeout: 30000 });
    const offline = await page.evaluate(() => ({
      controlled: navigator.serviceWorker.controller !== null,
      isolated: globalThis.crossOriginIsolated === true,
      online: navigator.onLine,
      workerStart: performance.getEntriesByType('navigation')[0]?.workerStart ?? 0,
    }));
    if (offline.online || !offline.controlled || !offline.isolated || !(offline.workerStart > 0)) {
      fail(`offline reload did not come from the worker: ${JSON.stringify(offline)}`);
      return;
    }
    console.info('offline reload booted from the service worker cache');

    // The demo's lazy chunks and data come from the release cache as well.
    await page.locator('[data-testid="start-demo"]').click();
    const opened = await page
      .waitForFunction(
        () => window.__sonareDebug?.initialized() === true && window.__sonareDebug.noteCount() > 0,
        null,
        { timeout: 30000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!opened) {
      const lastError = await page.evaluate(() => window.__sonareDebug?.lastError() ?? null);
      fail(`the demo did not open offline: ${JSON.stringify(lastError)}`);
    } else {
      console.info('the demo opened offline');
    }
  } finally {
    await context.close();
    await server.close();
  }
}
