import { rulerPoint } from '../geometry.mjs';

/**
 * Timeline markers: a marker added from the ruler menu is renamed and moved in
 * the Markers list, seeks the playhead from its row, and leaves the document
 * when deleted.
 */
export const name = 'timeline-markers';

const MARKER_PPQ = 8;
const MOVED_PPQ = 16;
const TOLERANCE_PPQ = 0.5;

const markers = (page) => page.evaluate(() => window.__sonareDebug.projectDocument().markers ?? []);

export async function run(ctx) {
  const { page, fail } = ctx;
  const before = await markers(page);

  // Add from the ruler's context menu and name it in the prompt.
  const point = await rulerPoint(page, MARKER_PPQ);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.locator('.context-menu-item[data-menu-item-id="marker"]').click();
  const prompt = page.locator('.modal-card:has(.dialog-input)');
  await prompt.waitFor({ state: 'visible', timeout: 5000 });
  await prompt.locator('.dialog-input').fill('Chorus');
  await prompt.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForFunction(
    (count) => (window.__sonareDebug.projectDocument().markers ?? []).length === count + 1,
    before.length,
    { timeout: 5000 },
  );
  const added = (await markers(page)).find((marker) => marker.name === 'Chorus');
  if (!added || Math.abs(added.ppq - MARKER_PPQ) > TOLERANCE_PPQ) {
    fail(`the ruler menu did not store Chorus near ppq ${MARKER_PPQ}: ${JSON.stringify(added)}`);
  }

  // Rename and move it from the Markers list.
  await page.click('.dock-tabs button:has-text("Lists")');
  await page.locator('.list-tab[data-tab-id="markers"]').click();
  const body = page.locator('.list-tab-body');
  await body.getByLabel('Name of marker Chorus').fill('Verse 2');
  await body.getByLabel('Name of marker Chorus').press('Tab');
  await body.getByLabel('Position of marker Verse 2 (bars.beats)').fill('5.1');
  await body.getByLabel('Position of marker Verse 2 (bars.beats)').press('Tab');
  await page.waitForFunction(
    (ppq) =>
      (window.__sonareDebug.projectDocument().markers ?? []).some(
        (marker) => marker.name === 'Verse 2' && Math.abs(marker.ppq - ppq) < 0.01,
      ),
    MOVED_PPQ,
    { timeout: 5000 },
  );
  console.info(`marker renamed and moved: ${JSON.stringify(await markers(page))}`);

  // The row's seek button moves the playhead onto the marker.
  await page.evaluate(() => window.__sonareDebug.seekPpq(0));
  await body.getByRole('button', { name: 'Seek to marker Verse 2' }).click();
  await page.waitForFunction(
    (ppq) => Math.abs(window.__sonareDebug.positionPpq() - ppq) < 0.01,
    MOVED_PPQ,
    { timeout: 5000 },
  );

  // Delete it: the document returns to the markers it started with.
  await body.getByRole('button', { name: 'Delete marker Verse 2' }).click();
  await page.waitForFunction(
    (count) => (window.__sonareDebug.projectDocument().markers ?? []).length === count,
    before.length,
    { timeout: 5000 },
  );
  await page.evaluate(() => window.__sonareDebug.seekPpq(0));
}
