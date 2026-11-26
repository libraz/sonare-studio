import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFreshPage, skipTour } from '../fresh-page.mjs';
import { createPagesServer } from '../pages-server.mjs';
import { inspectPdfFonts } from '../pdf-inspection.mjs';
import { downloadBytes } from '../wav-inspection.mjs';

const E2E_DIST = fileURLToPath(new URL('../../../.e2e-dist', import.meta.url));

/**
 * PWA: the build registers its service worker, precaches the release (all but
 * the on-demand PDF text font), advertises an installable web app manifest,
 * and — once the worker controls
 * the page — boots from its cache and opens the demo with the network cut.
 * Offline before the font was ever fetched, a PDF export with Japanese text
 * says so and points at Print instead of writing a file; once one online
 * export has fetched the font, the runtime cache serves it offline.
 * Runs in its own browser context, which is the only way to start with no
 * worker installed, against the build served with the static host's headers:
 * the preview server adds `Vary: Origin`, which the host does not send.
 */
export const name = 'pwa-offline';

export async function run(ctx) {
  const { page: sharedPage, fail } = ctx;
  const server = await createPagesServer({ dist: E2E_DIST });
  const { baseUrl } = server;
  const { context, page } = await openFreshPage(sharedPage, { acceptDownloads: true });
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
      const registration = await page
        .evaluate(async () => {
          const found = await navigator.serviceWorker.getRegistration('/');
          return {
            registered: Boolean(found),
            installing: found?.installing?.state ?? null,
            waiting: found?.waiting?.state ?? null,
            active: found?.active?.state ?? null,
            caches: await globalThis.caches.keys(),
          };
        })
        .catch((error) => ({ error: error.message }));
      const requests = server.getRequests();
      const served = requests.map((request) => request.pathname);
      const listed = JSON.parse(
        await readFile(join(E2E_DIST, 'precache-manifest.json'), 'utf8'),
      ).assets;
      const unrequested = listed.filter((asset) => !served.includes(asset));
      const unfinished = requests
        .filter((request) => request.status !== 200 || !request.completed)
        .map((request) => `${request.pathname} ${request.status} completed=${request.completed}`);
      fail(
        `the service worker never activated: ${JSON.stringify({ registered, registration })}; ` +
          `sw.js requested ${served.filter((path) => path === '/sw.js').length}x, ` +
          `${served.length} requests; precache assets never requested ${JSON.stringify(unrequested)}; ` +
          `not a completed 200 ${JSON.stringify(unfinished)}`,
      );
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
        fonts: manifest.assets.filter((asset) => asset.endsWith('.ttf')),
      };
    });
    if (precache.keys.length !== 1 || precache.listed < 5 || precache.missing.length > 0) {
      fail(`the release was not fully precached: ${JSON.stringify(precache)}`);
    }
    const builtFonts = (await readdir(join(E2E_DIST, 'assets'))).filter((file) =>
      file.endsWith('.ttf'),
    );
    if (builtFonts.length === 0) fail('the build emits no PDF text font asset');
    if (precache.fonts.length > 0) {
      fail(`the precache pulls in the on-demand PDF font: ${JSON.stringify(precache.fonts)}`);
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
      return;
    }
    console.info('the demo opened offline');

    await checkOfflinePdfFont(page, context, fail);
  } finally {
    await context.close();
    await server.close();
  }
}

const PDF_PART_NAME = 'ピアノ';
const FONT_UNAVAILABLE = 'could not be downloaded';

/** Clicks PDF and observes the terminal outcome of this attempt. */
async function exportPdf(page, expectMissingFont = false) {
  const button = page.locator('button.tb-action').filter({ hasText: /^\s*PDF\s*$/ });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button.tb-action')].some(
        (candidate) => candidate.textContent?.trim() === 'PDF' && !candidate.disabled,
      ),
    null,
    { timeout: 120000 },
  );
  const notice = page.locator('.score-error').filter({ hasText: FONT_UNAVAILABLE });
  const previousNotices = await notice.elementHandles();
  const downloaded = page.waitForEvent('download', { timeout: 120000 }).catch(() => null);
  await button.click();
  // Require a prior error to clear without mistaking the fresh offline error for it.
  await Promise.all(
    previousNotices.map((previous) =>
      page.waitForFunction((oldNotice) => !oldNotice.isConnected, previous, { timeout: 10000 }),
    ),
  );
  const outcome = expectMissingFont
    ? Promise.race([
        downloaded,
        notice.waitFor({ state: 'visible', timeout: 120000 }).then(() => null),
      ])
    : downloaded;
  const download = await outcome;
  return download ? downloadBytes(download) : null;
}

async function checkOfflinePdfFont(page, context, fail) {
  await skipTour(page);
  await page.evaluate(
    (partName) =>
      window.__sonareDebug.addNotedMidiClip(partName, 0, 16, [
        { pitch: 60, startPpq: 0, durationPpq: 4 },
      ]),
    PDF_PART_NAME,
  );
  await page.click('.dock-tabs button:has-text("Score")');
  await page
    .locator('.score-body svg g.note')
    .first()
    .waitFor({ state: 'attached', timeout: 120000 });

  const offlineFirst = await exportPdf(page, true);
  const notice =
    (await page
      .locator('.score-error')
      .textContent()
      .catch(() => null)) ?? '';
  if (offlineFirst !== null) {
    fail('an offline PDF export with Japanese text wrote a file without its font');
    return;
  }
  if (!notice.includes(FONT_UNAVAILABLE) || !notice.includes('Print')) {
    fail(`the offline PDF export did not explain the missing font: ${JSON.stringify(notice)}`);
    return;
  }
  console.info('offline PDF export without the font points at Print');

  await context.setOffline(false);
  const online = await exportPdf(page);
  if (online === null || inspectPdfFonts(online).cidFonts < 1) {
    fail('the online PDF export did not embed the text font');
    return;
  }
  const cachedFont = await page.evaluate(async () => {
    for (const key of await globalThis.caches.keys()) {
      const cache = await globalThis.caches.open(key);
      if ((await cache.keys()).some((entry) => entry.url.endsWith('.ttf'))) return true;
    }
    return false;
  });
  if (!cachedFont) {
    fail('the PDF text font fetched online did not land in the runtime cache');
    return;
  }

  await context.setOffline(true);
  const offlineAgain = await exportPdf(page);
  if (offlineAgain === null || inspectPdfFonts(offlineAgain).cidFonts < 1) {
    fail('the PDF export did not reuse the cached text font offline');
    return;
  }
  console.info('the cached PDF text font serves an offline export');
}
