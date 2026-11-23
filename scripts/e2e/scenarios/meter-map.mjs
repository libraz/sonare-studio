import { rulerPoint } from '../geometry.mjs';

/**
 * Meter map: a 3/4 entry applied in the Time Sig list changes the document
 * meter, the bar length the ruler menu offers and the playhead's bar.beat
 * mapping; one undo restores 4/4.
 */
export const name = 'meter-map';

const PLAYHEAD = 'Playhead position in bars, beats, sixteenths and ticks';

const meter = (page) =>
  page.evaluate(() =>
    window.__sonareDebug.projectDocument().timeSignatures.map((entry) => ({
      startPpq: entry.startPpq,
      numerator: entry.numerator,
      denominator: entry.denominator,
    })),
  );

/** Types a bar.beat.sixteenth.tick position into the transport readout. */
async function typePosition(page, text) {
  const field = page.getByLabel(PLAYHEAD);
  await field.focus();
  await field.fill(text);
  await field.press('Enter');
}

/** Bar length in PPQ that the ruler's Insert time prompt offers at a position. */
async function offeredBarLength(page, ppq) {
  const point = await rulerPoint(page, ppq);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.locator('.context-menu-item[data-menu-item-id="insert-time"]').click();
  const prompt = page.locator('.modal-card:has(.dialog-input)');
  await prompt.waitFor({ state: 'visible', timeout: 5000 });
  const value = await prompt.locator('.dialog-input').inputValue();
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await prompt.waitFor({ state: 'detached', timeout: 5000 });
  return Number(value);
}

export async function run(ctx) {
  const { page, fail } = ctx;
  const original = await meter(page);
  if (original.length !== 1 || original[0].numerator !== 4) {
    fail(`expected a single 4/4 entry to start from: ${JSON.stringify(original)}`);
    return;
  }
  const originalBar = await offeredBarLength(page, 1);
  await typePosition(page, '1.4.1.000');
  const beatFour = await page.evaluate(() => window.__sonareDebug.positionPpq());
  if (originalBar !== 4 || Math.abs(beatFour - 3) > 0.01) {
    fail(`4/4 baseline: bar ${originalBar} ppq, beat 4 at ${beatFour} ppq`);
  }

  // Change the first entry to 3 beats per bar.
  await page.click('.dock-tabs button:has-text("Lists")');
  await page.locator('.list-tab[data-tab-id="meter"]').click();
  const editor = page.locator('.list-editor').filter({
    has: page.getByLabel('Meter entry 1 beats per bar'),
  });
  await editor.getByLabel('Meter entry 1 beats per bar').fill('3');
  await editor.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(
    () => window.__sonareDebug.projectDocument().timeSignatures[0]?.numerator === 3,
    null,
    { timeout: 5000 },
  );

  // The bar grid follows: the bar is 3 beats long and bar 2 starts at ppq 3.
  const bar = await offeredBarLength(page, 1);
  await typePosition(page, '2.1.1.000');
  const barTwo = await page.evaluate(() => window.__sonareDebug.positionPpq());
  // Beat 4 no longer exists in a bar, so the readout refuses it and stays put.
  await page.evaluate(() => window.__sonareDebug.seekPpq(0));
  await typePosition(page, '1.4.1.000');
  const afterBeatFour = await page.evaluate(() => window.__sonareDebug.positionPpq());
  if (bar !== 3 || Math.abs(barTwo - 3) > 0.01 || Math.abs(afterBeatFour) > 0.01) {
    fail(`3/4 grid: bar ${bar} ppq, bar 2 at ${barTwo} ppq, beat 4 moved to ${afterBeatFour}`);
  } else {
    console.info(`3/4 applied: bar ${bar} ppq, bar 2 starts at ppq ${barTwo}`);
  }

  // One undo restores 4/4.
  await page.locator('.undo-toggle').click();
  await page.waitForFunction(
    () => window.__sonareDebug.projectDocument().timeSignatures[0]?.numerator === 4,
    null,
    { timeout: 5000 },
  );
  await page.evaluate(() => window.__sonareDebug.seekPpq(0));
}
