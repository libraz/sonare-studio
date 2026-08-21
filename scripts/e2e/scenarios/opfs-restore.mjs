/** Persistence: save to OPFS, reload, continue the session. */
export const name = 'opfs-restore';

export async function run(ctx) {
  const { page, fail } = ctx;
  const { expectedTracks } = ctx.state;

  // Save the project to OPFS via the project menu, then reload the page and
  // continue the autosaved session: the project must survive.
  await page.click('.app-menubar__trigger:has-text("File")');
  await page.locator('[id="menubar-file-file.save"]').click();
  // The save action is fire-and-forget, and the autosave readout is a standing
  // status element that appears on the first periodic autosave and never leaves
  // — waiting for it to exist proves nothing once that has happened, and the
  // reload below then races the write, restoring the revision before the edit.
  // The unsaved-changes marker clearing is what says the write finished.
  await page.waitForSelector('.dirty-dot', { state: 'detached', timeout: 20000 });
  await page.waitForSelector('.autosave-state', { timeout: 15000 });
  console.info('project saved to OPFS');

  await page.reload({ waitUntil: 'load' });
  // The start screen offers to continue the autosaved session after a reload.
  await page.waitForSelector('[data-testid="start-continue"]', { timeout: 30000 });
  await page.click('[data-testid="start-continue"]');
  // A bare timeout here says only "it did not happen", which cannot tell a slow
  // restore apart from one that came back with the wrong project. Report what
  // the page actually holds instead.
  try {
    await page.waitForFunction(
      (expected) =>
        window.__sonareDebug?.initialized() === true &&
        window.__sonareDebug.trackCount() === expected,
      expectedTracks,
      { timeout: 30000 },
    );
  } catch {
    const actual = await page.evaluate(() => ({
      initialized: window.__sonareDebug?.initialized() ?? null,
      tracks: window.__sonareDebug?.trackCount?.() ?? null,
      clips: window.__sonareDebug?.clipCount?.() ?? null,
      notes: window.__sonareDebug?.noteCount?.() ?? null,
    }));
    throw new Error(
      `restore did not settle: expected ${expectedTracks} tracks, page reports ` +
        JSON.stringify(actual),
    );
  }
  const restoredHeaders = await page.locator('.track-headers .track-header').count();
  if (restoredHeaders !== expectedTracks) {
    fail(`expected ${expectedTracks} track headers after reload, got ${restoredHeaders}`);
  } else {
    console.info(`project restored after reload: ${expectedTracks} track headers`);
  }

  // The shortcut override must survive the reload (localStorage) and still
}
