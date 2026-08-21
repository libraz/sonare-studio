/** Score: the panel engraves the project. */
export const name = 'score';

export async function run(ctx) {
  const { page, fail } = ctx;

  // Toggle the score panel and wait for the engraved SVG. On a cold dev
  // server the first open transforms and boots the ~8 MB Verovio wasm worker,
  // so allow a generous timeout.
  await page.click('.dock-tabs button:has-text("Score")');
  const scoreNote = page.locator('.score-body svg g.note').first();
  await scoreNote.waitFor({ state: 'attached', timeout: 120000 });
  const noteGroups = await page.locator('.score-body svg g.note').count();
  console.info(`score rendered: ${noteGroups} note group(s)`);

  const indicator = ((await page.locator('.score-page-indicator').textContent()) ?? '').trim();
  if (!/^1 \/ \d+$/.test(indicator)) {
    fail(`unexpected score page indicator: "${indicator}"`);
  } else {
    console.info(`score page indicator: ${indicator}`);
  }
}
