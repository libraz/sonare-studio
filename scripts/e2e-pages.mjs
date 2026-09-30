import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launchBrowser } from './e2e/harness.mjs';
import { createPagesServer } from './e2e/pages-server.mjs';

const args = process.argv.slice(2);
const distFlag = args.find((arg) => arg.startsWith('--dist='));
const dist = resolve(distFlag ? distFlag.slice('--dist='.length) : 'dist');
const timeout = 30000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForApp(page) {
  await page.waitForFunction(() => document.querySelector('#app')?.children.length > 0, null, {
    timeout,
  });
}

async function bootDemo(page) {
  await page.waitForSelector('[data-testid="start-demo"]', { timeout });
  await page.click('[data-testid="start-demo"]');
  await page.waitForSelector('.arrangement-view', { timeout });
  const tourSkip = page.locator('.tour-tooltip .tour-skip');
  if ((await tourSkip.count()) > 0 && (await tourSkip.isVisible())) await tourSkip.click();
  await page.locator('.tour-overlay').waitFor({ state: 'hidden', timeout });
  await page.locator('.modal-scrim.is-launcher-layer').waitFor({ state: 'hidden', timeout });

  // Production builds intentionally omit __sonareDebug. The enabled engine
  // status and a real transport cycle witness the same boot through the UI.
  const play = page.locator('button.transport-key.play');
  const initialPosition = await page.locator('.position-seconds').textContent();
  const initialSeconds = Number.parseFloat((initialPosition ?? '').replace('s', ''));
  assert(Number.isFinite(initialSeconds), `transport position is not numeric: ${initialPosition}`);
  await page.waitForFunction(
    () => {
      const button = document.querySelector('button.transport-key.play');
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    null,
    { timeout },
  );
  await play.click();
  await page.waitForSelector('.engine-status.engine-status-on', { timeout });
  await page.waitForFunction(
    (startSeconds) => {
      const text = document.querySelector('.position-seconds')?.textContent ?? '';
      const currentSeconds = Number.parseFloat(text.replace('s', ''));
      return Number.isFinite(currentSeconds) && currentSeconds > startSeconds;
    },
    initialSeconds,
    { timeout },
  );
  await page.locator('button.transport-key.stop').click();
  await page.waitForFunction(
    () =>
      document.querySelector('button.transport-key.play')?.getAttribute('aria-pressed') !== 'true',
    null,
    { timeout },
  );
}

async function waitForController(page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout });
}

async function waitForWaitingWorker(page, expectedCache = null) {
  await page.waitForFunction(
    async (cacheName) => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      if (!registration?.waiting) return false;
      if (!cacheName) return true;
      return (await caches.keys()).includes(cacheName);
    },
    expectedCache,
    { timeout },
  );
}

async function waitForRedundantInstall(page) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await new Promise((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error('timed out waiting for the failed worker to become redundant')),
        30000,
      );
      const done = () => {
        window.clearTimeout(timer);
        resolve();
      };
      const observe = (worker) => {
        if (!worker) return;
        if (worker.state === 'redundant') {
          done();
          return;
        }
        worker.addEventListener('statechange', () => {
          if (worker.state === 'redundant') done();
        });
      };
      registration.addEventListener('updatefound', () => observe(registration.installing), {
        once: true,
      });
      void registration.update().catch(() => undefined);
    });
  });
}

async function cacheNames(page) {
  return page.evaluate(async () =>
    (await caches.keys()).filter((key) => key.startsWith('sonare-studio-')),
  );
}

async function activeCacheName(page) {
  const names = await cacheNames(page);
  assert(names.length === 1, `expected one active release cache, found ${JSON.stringify(names)}`);
  return names[0];
}

async function writeOpfsSentinel(page) {
  return page.evaluate(async () => {
    if (typeof navigator.storage?.getDirectory !== 'function') {
      throw new Error('production Chromium does not expose Origin Private File System');
    }
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('__sonare-pages-e2e-sentinel__', { create: true });
    const writable = await handle.createWritable();
    await writable.write('survives-worker-activation');
    await writable.close();
    return true;
  });
}

async function readOpfsSentinel(page) {
  return page.evaluate(async () => {
    if (typeof navigator.storage?.getDirectory !== 'function') {
      throw new Error('production Chromium does not expose Origin Private File System');
    }
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('__sonare-pages-e2e-sentinel__');
    return handle.getFile().then((file) => file.text());
  });
}

async function activateWaitingWorker(page) {
  const reloadButton = page.locator('.pwa-update button:not(.pwa-update-dismiss)');
  await reloadButton.waitFor({ state: 'visible', timeout });
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }),
      reloadButton.click(),
    ]);
  } catch (error) {
    const state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      return {
        banner: document.querySelector('.pwa-update')?.textContent,
        controller: navigator.serviceWorker.controller?.state,
        waiting: registration?.waiting?.state,
        installing: registration?.installing?.state,
        cacheNames: await caches.keys(),
      };
    });
    throw new Error(`Update reload failed: ${JSON.stringify(state)}`, { cause: error });
  }
  await waitForApp(page);
}

async function checkPagesContract(context, baseUrl) {
  const redirect = await context.request.get(`${baseUrl}/index.html`, { maxRedirects: 0 });
  assert(redirect.status() === 308, `expected /index.html to redirect, got ${redirect.status()}`);
  assert(
    redirect.headers().location === '/',
    `expected canonical redirect to /, got ${redirect.headers().location}`,
  );

  const root = await context.request.get(`${baseUrl}/`);
  assert(root.status() === 200, `expected / to return 200, got ${root.status()}`);
  assert(root.headers()['cross-origin-opener-policy'] === 'same-origin', 'root is missing COOP');
  assert(root.headers()['cross-origin-embedder-policy'] === 'require-corp', 'root is missing COEP');
  assert(root.headers()['cache-control'] === 'no-cache', 'root is not revalidated');

  const missingRoute = await context.request.get(`${baseUrl}/projects/missing-route`);
  assert(
    missingRoute.status() === 200,
    `expected SPA fallback to return 200, got ${missingRoute.status()}`,
  );
  assert(
    (missingRoute.headers()['content-type'] ?? '').startsWith('text/html'),
    'SPA fallback is not HTML',
  );
  const missingAsset = await context.request.get(`${baseUrl}/assets/old-release.js`);
  assert(
    missingAsset.status() === 200,
    `expected Pages catch-all for a missing asset, got ${missingAsset.status()}`,
  );
  assert(
    (missingAsset.headers()['content-type'] ?? '').startsWith('text/html'),
    'missing asset did not receive the SPA HTML fallback',
  );
  const manifest = await context.request.get(`${baseUrl}/precache-manifest.json`);
  const manifestJson = await manifest.json();
  assert(
    manifest.headers()['cache-control'] === 'no-cache',
    'precache manifest is not revalidated',
  );
  assert(manifestJson.assets.includes('/'), 'precache manifest has no canonical shell');
  assert(
    !manifestJson.assets.includes('/index.html'),
    'precache manifest still uses legacy shell key',
  );
  return manifestJson;
}

async function run() {
  const manifestText = await readFile(join(dist, 'precache-manifest.json'), 'utf8');
  const sourceManifest = JSON.parse(manifestText);
  const failedAsset = sourceManifest.assets.find(
    (asset) => asset.startsWith('/assets/') && asset.endsWith('.js'),
  );
  assert(failedAsset, 'production precache manifest has no JavaScript asset to fail');

  const server = await createPagesServer({ dist });
  const legacyServer = await createPagesServer({ dist });
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('sonare-studio.tourSeen', '1'));
  let page = await context.newPage();
  let legacyContext = null;
  const pageErrors = [];
  const observePage = (observedPage) => {
    observedPage.on('pageerror', (error) => pageErrors.push(error.message));
    observedPage.on('console', (message) => {
      if (message.type() === 'error') console.error(`browser console: ${message.text()}`);
    });
  };
  observePage(page);

  try {
    const manifestA = await checkPagesContract(context, server.baseUrl);

    // First visit installs the worker. The next ordinary reload must be the
    // first controlled navigation and must boot from the canonical shell.
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);
    await bootDemo(page);
    await page.evaluate(async () => navigator.serviceWorker.ready);
    await waitForController(page);
    assert(
      (await page.locator('.pwa-update').count()) === 0,
      'first Service Worker claim was incorrectly reported as an available update',
    );
    await page.reload({ waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);
    await waitForController(page);
    assert(
      await page.evaluate(() => crossOriginIsolated),
      'production page is not cross-origin isolated',
    );
    const cacheA = await activeCacheName(page);
    assert(cacheA === manifestA.cacheVersion, `active cache differs from manifest: ${cacheA}`);
    const staleAsset = await page.evaluate(async () => {
      const response = await fetch('/assets/old-release.js');
      return { status: response.status, contentType: response.headers.get('content-type') };
    });
    assert(staleAsset.status === 404, `stale asset was not rejected: ${staleAsset.status}`);

    // A controlled revisit while online exercises the ordinary cache-first
    // navigation path rather than the install-time fetch path.
    await page.reload({ waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);

    // The active release must remain usable offline after a normal revisit.
    server.setOnline(false);
    await page.reload({ waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);
    server.setOnline(true);

    // Storage eviction is recoverable while the active worker remains. The
    // worker must repair the complete release before returning the shell.
    await page.evaluate(async (name) => {
      if (!(await caches.delete(name))) throw new Error(`could not evict ${name}`);
    }, cacheA);
    await page.reload({ waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);
    assert((await activeCacheName(page)) === cacheA, 'evicted release was not repaired');
    await writeOpfsSentinel(page);

    // Close every A tab before publishing B. The next page below is a genuine
    // first revisit after a user closed the old tab, rather than a second page
    // opened while the original A client is still alive.
    for (const openPage of context.pages()) await openPage.close();

    // Install the real old navigation worker in an isolated context. Its
    // install fetches /index.html through Pages' 308 and stores the redirected
    // response under the legacy key, so B must repair an actual Cache Storage
    // entry while this worker remains active.
    legacyServer.setServiceWorkerVariant('legacy');
    legacyContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await legacyContext.addInitScript(() => localStorage.setItem('sonare-studio.tourSeen', '1'));
    const legacyPage = await legacyContext.newPage();
    observePage(legacyPage);
    // Register on a plain document so the app's own update checks cannot
    // install another worker between the legacy setup and the B publish.
    await legacyPage.goto(`${legacyServer.baseUrl}/legacy-probe.html`, {
      waitUntil: 'domcontentloaded',
      timeout,
    });
    await legacyPage.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
    });
    await waitForController(legacyPage);
    const legacyCacheState = await legacyPage.evaluate(async () => {
      const cache = await caches.open('sonare-studio-legacy');
      const response = await cache.match('/index.html');
      return response
        ? { location: response.headers.get('location'), redirected: response.redirected }
        : null;
    });
    assert(
      legacyCacheState?.redirected,
      'legacy worker did not cache Pages redirect under /index.html',
    );

    // Publish B. It installs beside the real legacy worker and waits, so an
    // ordinary reload still runs the old navigation handler after migration.
    const legacyCacheB = await legacyServer.addRelease('b');
    legacyServer.setRelease('b');

    await legacyPage.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
    });
    await waitForWaitingWorker(legacyPage, legacyCacheB);
    const migratedLegacy = await legacyPage.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const keys = await caches.keys();
      const response = await (await caches.open('sonare-studio-legacy')).match('/index.html');
      return {
        active: registration?.active?.scriptURL,
        installing: registration?.installing?.scriptURL,
        waiting: registration?.waiting?.scriptURL,
        keys,
        response: response
          ? { location: response.headers.get('location'), redirected: response.redirected }
          : null,
      };
    });
    assert(
      migratedLegacy.response?.redirected === false,
      `B did not repair the real legacy shell response: ${JSON.stringify(migratedLegacy)}`,
    );
    assert(
      migratedLegacy.response.location === null,
      `B left Location on the real legacy shell response: ${JSON.stringify(migratedLegacy)}`,
    );
    await legacyPage.goto(legacyServer.baseUrl, { waitUntil: 'domcontentloaded', timeout });
    await waitForApp(legacyPage);
    await legacyContext.close();
    legacyContext = null;

    const cacheB = await server.addRelease('b');
    server.setRelease('b');

    // This is the fixed A -> B first normal revisit in the original context.
    // A still controls the new page and serves its repaired shell while B waits.
    page = await context.newPage();
    observePage(page);
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);
    await waitForController(page);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
    });
    await waitForWaitingWorker(page, cacheB);
    const waitingCaches = await cacheNames(page);
    assert(waitingCaches.includes(cacheA), 'active A cache disappeared while B waited');
    assert(waitingCaches.includes(cacheB), 'waiting B cache was not installed');
    await activateWaitingWorker(page);
    assert((await activeCacheName(page)) === cacheB, 'B did not become the active release');
    assert(
      (await readOpfsSentinel(page)) === 'survives-worker-activation',
      'OPFS data did not survive worker activation',
    );

    // Publish C with one precache failure. The failed install must not delete
    // B or activate a partially populated cache.
    const cacheC = await server.addRelease('c');
    server.setRelease('c');
    server.setFailure(failedAsset);
    await waitForRedundantInstall(page);
    await page.waitForFunction(
      async ([activeCache, failedCache]) => {
        const names = (await caches.keys()).filter((key) => key.startsWith('sonare-studio-'));
        return names.includes(activeCache) && !names.includes(failedCache);
      },
      [cacheB, cacheC],
      { timeout },
    );
    const afterFailedInstall = await cacheNames(page);
    assert(afterFailedInstall.includes(cacheB), 'active B cache was lost after C failed');
    assert(!afterFailedInstall.includes(cacheC), 'partial C cache survived a failed install');
    const activeScript = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.active?.scriptURL;
    });
    assert(activeScript?.endsWith('/sw.js'), 'active worker disappeared after partial install');
    await page.reload({ waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);

    assert(pageErrors.length === 0, `unexpected browser errors: ${pageErrors.join('; ')}`);
    console.info(
      'PASS Pages production E2E: canonical redirect, shell recovery, and release lifecycle',
    );
  } finally {
    await legacyContext?.close();
    await context.close();
    await browser.close();
    await server.close();
    await legacyServer.close();
  }
}

try {
  await run();
} catch (error) {
  console.error(
    `FAIL Pages production E2E: ${error instanceof Error ? error.stack : String(error)}`,
  );
  process.exitCode = 1;
}
