/** Measure a real project, apply the mix suggestion, then undo it as one edit. */
export const name = 'mix-suggestion';

export async function run(ctx) {
  const { page, fail } = ctx;
  const trackId = await page.evaluate(() => window.__sonareDebug.trackIds()[0]);
  const readMix = () =>
    page.evaluate(() => {
      const doc = window.__sonareDebug.projectDocument();
      return JSON.stringify({
        tracks: doc.tracks.map((track) => ({
          mixer: track.mixer ?? null,
          mute: track.mute,
          solo: track.solo,
          pan: track.pan,
          volume: track.volume,
          vcaId: track.vcaId,
        })),
        master: doc.mixer?.master ?? null,
        buses: doc.mixer?.buses ?? [],
        vcaGroups: doc.mixer?.vcaGroups ?? [],
      });
    });
  const original = await readMix();
  let restored = false;

  try {
    // An attenuated fader must not hide the source from dry-stem analysis.
    await page.evaluate((id) => window.__sonareDebug.setStripGainDb(id, -30), trackId);
    const before = await readMix();
    await page.click('.dock-tabs button:has-text("Mixer")');
    await page
      .locator('.mixer-panel .mixer-toolbar .view-menu-wrap')
      .first()
      .locator('button')
      .first()
      .click();
    await page
      .locator('.mixer-panel .scene-menu [role="menuitem"]', { hasText: 'Suggest a mix' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Suggest a mix' });
    await dialog.locator('.suggest-mix-tracks tbody tr').first().waitFor({ timeout: 90000 });
    const rows = await dialog.locator('.suggest-mix-tracks tbody tr').count();
    if (rows === 0) fail('mix assistant did not measure any tracks');
    await dialog.getByRole('button', { name: 'Apply suggestion' }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 10000 });

    const after = await readMix();
    if (after === before) fail('mix assistant applied no mixer changes');
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction(
      (previous) => {
        const doc = window.__sonareDebug.projectDocument();
        return (
          JSON.stringify({
            tracks: doc.tracks.map((track) => ({
              mixer: track.mixer ?? null,
              mute: track.mute,
              solo: track.solo,
              pan: track.pan,
              volume: track.volume,
              vcaId: track.vcaId,
            })),
            master: doc.mixer?.master ?? null,
            buses: doc.mixer?.buses ?? [],
            vcaGroups: doc.mixer?.vcaGroups ?? [],
          }) === previous
        );
      },
      before,
      { timeout: 10000 },
    );
    console.info(
      `mix assistant measured ${rows} track(s), changed the scene, and undid in one step`,
    );
  } finally {
    const dialog = page.getByRole('dialog', { name: 'Suggest a mix' });
    if (await dialog.isVisible().catch(() => false)) await page.keyboard.press('Escape');
    // The harness runs later scenarios even after a failure, so restore the
    // mixer edits made by this scenario before handing the shared page back.
    for (let attempt = 0; attempt < 2 && (await readMix()) !== original; attempt++) {
      await page.keyboard.press('ControlOrMeta+z');
    }
    restored = (await readMix()) === original;
  }
  if (!restored) fail('mix suggestion E2E left mixer changes in the shared project');
}
