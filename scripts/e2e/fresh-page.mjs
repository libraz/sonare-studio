/**
 * A page in its own browser context for scenarios that replace the project,
 * install a service worker or change stored settings, none of which the shared
 * page may carry into the scenarios after them.
 */

/**
 * @param sharedPage The runner's page; its browser owns the new context.
 * @param options Extra context options, e.g. `locale`.
 * @returns The context to close afterwards and the page opened in it.
 */
export async function openFreshPage(sharedPage, options = {}) {
  const browser = sharedPage.context().browser();
  if (!browser) throw new Error('the E2E page has no browser owner');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, ...options });
  const page = await context.newPage();
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
  return { context, page };
}

/** Opens the bundled demo from the start screen and waits for its notes. */
export async function openDemo(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.locator('[data-testid="start-demo"]').click();
  await page.waitForFunction(
    () => window.__sonareDebug?.initialized() === true && window.__sonareDebug.noteCount() > 0,
    null,
    { timeout: 60000 },
  );
}

/** Dismisses the first-run welcome tour, which opens a moment after the shell mounts. */
export async function skipTour(page) {
  await page.locator('.tour-tooltip').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('.tour-tooltip .tour-skip').click();
  await page.locator('.tour-overlay').waitFor({ state: 'detached', timeout: 10000 });
}

/** Starts a new project from the empty template and waits for the arrangement. */
export async function openEmptyProject(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.locator('[data-testid="start-new"]').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('[data-testid="start-new"]').click();
  await page.locator('#new-project-template-empty').click();
  await page
    .locator('.modal-card:has(#new-project-template-empty) .modal-foot button.primary')
    .click();
  await page.locator('.modal-scrim.is-launcher-layer').waitFor({ state: 'detached' });
  await page.locator('.arrangement-canvas').waitFor({ state: 'visible', timeout: 30000 });
}
