/** Mixer tab: one channel strip per track plus the master strip. */
export const name = 'mixer-strips';

export async function run(ctx) {
  const { page, fail } = ctx;

  await page.click('.dock-tabs button:has-text("Mixer")');
  await page.waitForSelector('.mixer-strips .channel-strip', { timeout: 10000 });
  const stripCount = await page.locator('.mixer-strips .channel-strip').count();
  const mixerTrackCount = await page.evaluate(() => window.__sonareDebug.trackCount());
  if (stripCount !== mixerTrackCount + 1) {
    fail(`expected ${mixerTrackCount} track strips + master, got ${stripCount} strips`);
  } else {
    console.info(`mixer shows ${mixerTrackCount} track strips + master`);
  }
}
