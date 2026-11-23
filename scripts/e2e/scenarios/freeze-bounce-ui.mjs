import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';
import { arrangementPoint } from '../geometry.mjs';

/**
 * Freeze and bounce from the track header: Freeze (More actions panel) bakes
 * the track without changing the master level and locks its clips, Unfreeze
 * (header menu) brings the live render back, and Bounce in place (header menu)
 * adds a track that doubles the loop region. A freeze bakes the whole project
 * span, so it runs on an empty project of its own rather than the demo.
 */
export const name = 'freeze-bounce-ui';

const TRACK = 'Freeze UI';
const LOOP = { startPpq: 0, endPpq: 2 };

const probe = (page, startPpq, endPpq) =>
  page.evaluate((range) => window.__sonareDebug.exportProbe(false, range), { startPpq, endPpq });

const frozenCount = (page) =>
  page.evaluate(() => window.__sonareDebug.trackFrozenStates().filter((s) => s !== null).length);

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await openEmptyProject(page, baseUrl);
    await skipTour(page);
    await exercise(page, fail);
  } finally {
    await context.close();
  }
}

async function exercise(page, fail) {
  const trackCountBefore = await page.evaluate(() => window.__sonareDebug.trackCount());
  const setup = await page.evaluate(async (trackName) => {
    const id = window.__sonareDebug.addAudioTrack(trackName);
    const clipId = await window.__sonareDebug.addToneClip(id, 2.0, 440, 0.5, 0);
    return { id, clipId };
  }, TRACK);
  await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
    timeout: 20000,
  });
  const header = page.locator('.track-headers .track-header', { hasText: TRACK });
  const freezeButton = header.locator(`button[aria-label="Freeze ${TRACK}"]`);
  // The header column scrolls with the lanes; bring the new track into view before using it.
  const revealHeader = () => arrangementPoint(page, setup.id, 1);
  const openMenu = async (id) => {
    await revealHeader();
    await header.click({ button: 'right' });
    await page.locator(`.context-menu-item[data-menu-item-id="${id}"]`).click();
  };
  const before = (await probe(page, 0, 4)).peakDb;

  // Freeze from the header's More actions panel: the track holds a bake and the level is unchanged.
  await revealHeader();
  await header.locator(`button[aria-label="More actions for ${TRACK}"]`).click();
  await freezeButton.click();
  await page.waitForFunction(
    () => window.__sonareDebug.trackFrozenStates().some((state) => state !== null),
    null,
    { timeout: 60000 },
  );
  const frozen = (await probe(page, 0, 4)).peakDb;
  if (
    (await freezeButton.getAttribute('aria-pressed')) !== 'true' ||
    Math.abs(before - frozen) > 1
  ) {
    fail(
      `freeze: pressed ${await freezeButton.getAttribute('aria-pressed')}, ${before.toFixed(1)} dB -> ${frozen.toFixed(1)} dB`,
    );
  }

  // A frozen track refuses clip edits: its menu entries are disabled and Delete keeps the clip.
  const clipCount = await page.evaluate(() => window.__sonareDebug.clipCount());
  const point = await arrangementPoint(page, setup.id, 1);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  const split = page.locator('.context-menu-item[data-menu-item-id="split"]');
  await split.waitFor({ state: 'visible', timeout: 5000 });
  const splitRefused = await split.isDisabled();
  await page.keyboard.press('Escape');
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  const clipsAfterDelete = await page.evaluate(() => window.__sonareDebug.clipCount());
  const editedFrozen = (await probe(page, 0, 4)).peakDb;
  if (!splitRefused || clipsAfterDelete !== clipCount || Math.abs(before - editedFrozen) > 1) {
    fail(
      `frozen edit: split disabled ${splitRefused}, clips ${clipCount} -> ${clipsAfterDelete}, ` +
        `${editedFrozen.toFixed(1)} dB`,
    );
  }

  // Unfreeze from the header menu: the live render comes back at the same level.
  await openMenu('freeze');
  await page.waitForFunction(
    () => window.__sonareDebug.trackFrozenStates().every((state) => state === null),
    null,
    { timeout: 10000 },
  );
  const unfrozen = (await probe(page, 0, 4)).peakDb;
  if ((await frozenCount(page)) !== 0 || Math.abs(before - unfrozen) > 1) {
    fail(`unfreeze: ${before.toFixed(1)} dB -> ${unfrozen.toFixed(1)} dB`);
  } else {
    console.info(
      `freeze: before ${before.toFixed(1)} dB, frozen ${frozen.toFixed(1)} dB, ` +
        `unfrozen ${unfrozen.toFixed(1)} dB`,
    );
  }

  // Bounce in place over the loop region adds a track; the first half doubles.
  await page.evaluate(
    (range) => window.__sonareDebug.setLoopRange(range.startPpq, range.endPpq, true),
    LOOP,
  );
  await openMenu('bounce');
  await page.waitForFunction(
    (count) => window.__sonareDebug.trackCount() === count + 2,
    trackCountBefore,
    {
      timeout: 30000,
    },
  );
  const doubled = (await probe(page, LOOP.startPpq, LOOP.endPpq)).peakDb;
  const single = (await probe(page, 2, 4)).peakDb;
  if (!(doubled > single + 4 && doubled < single + 8)) {
    fail(
      `bounce: loop region ${doubled.toFixed(1)} dB vs original only ${single.toFixed(1)} dB, ` +
        'expected about +6 dB',
    );
  } else {
    console.info(`bounce: ${doubled.toFixed(1)} dB in the loop vs ${single.toFixed(1)} dB outside`);
  }
}
