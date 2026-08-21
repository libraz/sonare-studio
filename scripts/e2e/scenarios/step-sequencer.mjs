/** Steps tab: bake a 4-step pattern into the active clip. */
export const name = 'step-sequencer';

export async function run(ctx) {
  const { page } = ctx;

  await page.click('.dock-tabs button:has-text("Steps")');
  await page.waitForSelector('.step-sequencer [data-test="apply"]:not([disabled])', {
    timeout: 10000,
  });
  for (const step of [0, 4, 8, 12]) {
    await page.click(`.step-grid .grid-cell[data-row="0"][data-step="${step}"]`);
  }
  const notesBeforeApply = await page.evaluate(() => window.__sonareDebug.noteCount());
  await page.click('.step-sequencer [data-test="apply"]');
  await page.waitForFunction(() => window.__sonareDebug.noteCount() === 4, null, {
    timeout: 10000,
  });
  console.info(`step pattern applied: ${notesBeforeApply} -> 4 notes`);
}
