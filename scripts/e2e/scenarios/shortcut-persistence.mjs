/** Settings: the remapped shortcut survives a reload and resets. */
export const name = 'shortcut-persistence';

export async function run(ctx) {
  const { page, fail } = ctx;
  const { remapKeys } = ctx.state;

  // drive the action; the per-row reset must then restore the default.
  const persistedKeys = await page.evaluate(() => {
    const raw = localStorage.getItem('sonare-studio.shortcuts');
    return raw ? (JSON.parse(raw).overrides?.['view.toggleScorePanel'] ?? null) : null;
  });
  if (JSON.stringify(persistedKeys) !== JSON.stringify(remapKeys)) {
    fail(
      `shortcut override lost across reload: stored ${JSON.stringify(remapKeys)}, ` +
        `read back ${JSON.stringify(persistedKeys)}`,
    );
  }
  // The score panel's own visibility is persisted too, so whether the reload
  // comes back with it open depends on everything above. Drive it as a toggle
  // from whatever state it is in and put it back, rather than assuming one.
  const scoreOpenAfterReload = (await page.locator('.score-host').count()) > 0;
  const awayState = scoreOpenAfterReload ? 'detached' : 'visible';
  const backState = scoreOpenAfterReload ? 'visible' : 'detached';
  await page.keyboard.press('F9');
  await page.waitForSelector('.score-host', { state: awayState, timeout: 5000 });
  await page.keyboard.press('F9');
  await page.waitForSelector('.score-host', { state: backState, timeout: 5000 });
  console.info('remapped shortcut persisted across reload and still works');

  await page.click('.app-menubar__trigger:has-text("Options")');
  await page.locator('[id="menubar-options-options_2e_settings"]').click();
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 5000 });
  await page.click('[role="dialog"][aria-label="Settings"] [role="tab"]:has-text("Shortcuts")');
  await page.click('tr[data-action-id="view.toggleScorePanel"] button[aria-label^="Reset keys"]');
  const afterReset = await page.evaluate(() => {
    const raw = localStorage.getItem('sonare-studio.shortcuts');
    return raw ? (JSON.parse(raw).overrides?.['view.toggleScorePanel'] ?? null) : null;
  });
  if (afterReset !== null) {
    fail(`shortcut reset did not clear the override: ${JSON.stringify(afterReset)}`);
  }
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', {
    state: 'detached',
    timeout: 5000,
  });
  console.info('shortcut reset restored the default binding');
}
