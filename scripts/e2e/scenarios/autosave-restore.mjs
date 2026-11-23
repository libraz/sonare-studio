import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';

/**
 * Autosave: with the interval set to its 5 s minimum in Settings, an edit is
 * written to the autosave slot once the interval has passed with no manual
 * save, and after a reload the start screen's Continue last session brings
 * the edit back.
 */
export const name = 'autosave-restore';

const INTERVAL_SECONDS = 5;
const TRACK = 'Autosaved part';
/** Wait past the interval for the write to land; the OPFS write itself is a few ms. */
const SAVE_DEADLINE_MS = INTERVAL_SECONDS * 1000 + 15000;

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await openEmptyProject(page, baseUrl);
    await skipTour(page);

    await page.click('.app-menubar__trigger:has-text("Options")');
    await page
      .locator('.menu-panel [role="menuitem"]')
      .filter({ hasText: /^Settings/ })
      .click();
    const settings = page.locator('[role="dialog"][aria-label="Settings"]');
    await settings.waitFor({ timeout: 5000 });
    await settings.locator('[role="tab"]:has-text("General")').click();
    const interval = settings.getByLabel('Autosave interval (seconds)');
    await interval.fill(String(INTERVAL_SECONDS));
    await interval.press('Tab');
    if ((await interval.inputValue()) !== String(INTERVAL_SECONDS)) {
      fail(
        `the autosave interval did not take ${INTERVAL_SECONDS}: ${await interval.inputValue()}`,
      );
      return;
    }
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'detached', timeout: 5000 });

    // Any readout so far predates the edit; a write after it re-keys the element.
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('.autosave-state')) {
        element.dataset.beforeEdit = 'true';
      }
    });
    await page.click('.track-headers .add-track');
    await page.click('.add-track-items button:has-text("Audio track")');
    const header = page.locator('.track-headers .track-header').last();
    await header.locator('.track-name').dblclick();
    await page.locator('.track-name-input').fill(TRACK);
    await page.keyboard.press('Enter');
    const editedAt = Date.now();
    const expectedTracks = await page.evaluate(() => window.__sonareDebug.trackCount());

    try {
      await page.waitForSelector('.autosave-state:not([data-before-edit])', {
        timeout: SAVE_DEADLINE_MS,
      });
    } catch {
      fail(`no autosave was written within ${SAVE_DEADLINE_MS} ms of the edit`);
      return;
    }
    const savedAfterMs = Date.now() - editedAt;
    // Still unsaved: the write came from autosave, not from File > Save.
    if ((await page.locator('.project-name .dirty-dot').count()) !== 1) {
      fail('the project lost its unsaved-changes marker, so the write was not an autosave');
    }

    await page.reload({ waitUntil: 'load' });
    await page.locator('[data-testid="start-continue"]').waitFor({ timeout: 30000 });
    await page.locator('[data-testid="start-continue"]').click();
    try {
      await page.waitForFunction(
        (count) =>
          window.__sonareDebug?.initialized() === true &&
          window.__sonareDebug.trackCount() === count,
        expectedTracks,
        { timeout: 30000 },
      );
    } catch {
      const actual = await page.evaluate(() => ({
        initialized: window.__sonareDebug?.initialized() ?? null,
        tracks: window.__sonareDebug?.trackCount?.() ?? null,
      }));
      fail(`the restored project has ${JSON.stringify(actual)}, expected ${expectedTracks} tracks`);
      return;
    }
    const names = await page.locator('.track-headers .track-header .track-name').allTextContents();
    if (!names.map((text) => text.trim()).includes(TRACK)) {
      fail(`the restored track headers do not show "${TRACK}": ${JSON.stringify(names)}`);
    }
    console.info(
      `autosave: written ${savedAfterMs} ms after the edit with a ${INTERVAL_SECONDS} s interval, ` +
        `restored tracks ${JSON.stringify(names)}`,
    );
  } finally {
    await context.close();
  }
}
