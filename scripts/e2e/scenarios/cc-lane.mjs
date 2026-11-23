import { lanePoint } from '../geometry.mjs';

/**
 * Controller lane: a CC11 curve drawn in the piano roll's lane is stored on the
 * clip and lowers the rendered level of its notes.
 */
export const name = 'cc-lane';

const LOOP = { startPpq: 1, endPpq: 3 };
const DRAWN_FRACTION = 0.15;

const probe = (page) =>
  page.evaluate((range) => window.__sonareDebug.exportProbe(false, range, true), LOOP);

const stemPeak = (result, trackName) => {
  const stem = result.stems?.find((entry) => entry.name === trackName);
  if (!stem) throw new Error(`no stem named ${trackName}: ${JSON.stringify(result.stems)}`);
  return stem.peakDb;
};

export async function run(ctx) {
  const { page, fail } = ctx;
  const trackCountBefore = await page.evaluate(() => window.__sonareDebug.trackCount());
  const activeClipBefore = await page.evaluate(() => window.__sonareDebug.activeClipId());
  const added = await page.evaluate(() => window.__sonareDebug.addMidiTestClip('CC lane', 0));
  await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
    timeout: 20000,
  });
  const open = stemPeak(await probe(page), 'CC lane');

  // Show the lane, pick CC11 and draw a low plateau across the clip.
  await page.click('.dock-tabs button:has-text("Piano Roll")');
  const lane = page.locator('.cell-velocity canvas');
  if (!(await lane.isVisible())) {
    await page.locator('.roll-toolbar').getByRole('button', { name: 'Lane', exact: true }).click();
  }
  await page.locator('.lane-mode-select .select-trigger').click();
  await page.getByRole('option', { name: 'CC · CC11', exact: true }).click();
  await lane.waitFor({ state: 'visible', timeout: 5000 });
  const from = await lanePoint(page, 0.25, DRAWN_FRACTION);
  const to = await lanePoint(page, 3.75, DRAWN_FRACTION);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 12 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();

  const stored = await page.evaluate(
    (name) =>
      window.__sonareDebug
        .projectDocument()
        .tracks.find((track) => track.name === name)
        ?.clips[0]?.ccLanes?.find((entry) => entry.controller === 11) ?? null,
    'CC lane',
  );
  const values = stored?.points.map((point) => point.value) ?? [];
  if (values.length < 2 || values.some((value) => value > 40)) {
    fail(`the drawn CC11 curve is not on the clip: ${JSON.stringify(stored)}`);
  }
  await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
    timeout: 20000,
  });

  // The curve reaches the render: expression at about 15 percent is much quieter.
  const lowered = stemPeak(await probe(page), 'CC lane');
  if (!(open - lowered > 6)) {
    fail(`CC11 did not lower the render: ${open.toFixed(1)} dB -> ${lowered.toFixed(1)} dB`);
  } else {
    console.info(
      `CC11 lane: ${values.length} points, render ${open.toFixed(1)} dB -> ${lowered.toFixed(1)} dB`,
    );
  }

  await page.evaluate((id) => window.__sonareDebug.removeTrack(id), added.trackId);
  await page.waitForFunction(
    (count) => window.__sonareDebug.trackCount() === count,
    trackCountBefore,
    { timeout: 5000 },
  );
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), activeClipBefore);
}
