/** Settings: remap a shortcut by key capture and verify it works. */
export const name = 'shortcut-remap';

export async function run(ctx) {
  const { page, fail } = ctx;

  await page.click('.app-menubar__trigger:has-text("Options")');
  await page
    .locator('.menu-panel [role="menuitem"]')
    .filter({ hasText: /^Settings/ })
    .click();
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 5000 });
  await page.click('[role="dialog"][aria-label="Settings"] [role="tab"]:has-text("Shortcuts")');
  await page.click('tr[data-action-id="view.toggleScorePanel"] button[aria-label^="Change keys"]');
  await page.keyboard.press('F9');
  const remapKeys = await page.evaluate(() => {
    const raw = localStorage.getItem('sonare-studio.shortcuts');
    return raw ? (JSON.parse(raw).overrides?.['view.toggleScorePanel'] ?? null) : null;
  });
  // Key capture ADDS a binding rather than replacing one — an action may carry
  // several combos, and dropping the old one is the separate clear action. The
  // default is therefore still there, which is asserted rather than named so
  // this does not restate the app's own default table.
  if (!Array.isArray(remapKeys) || remapKeys.at(-1) !== 'f9') {
    fail(`captured key not stored last: ${JSON.stringify(remapKeys)}`);
  } else if (remapKeys.length < 2) {
    fail(`capture replaced the existing binding instead of adding to it: ${remapKeys.join()}`);
  }
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', {
    state: 'detached',
    timeout: 5000,
  });
  // The remapped key drives the action immediately: F9 toggles the score panel.
  await page.keyboard.press('F9');
  await page.waitForSelector('.score-host', { state: 'detached', timeout: 5000 });
  await page.keyboard.press('F9');
  await page.waitForSelector('.score-host', { timeout: 5000 });
  console.info('shortcut remapped to F9 via key capture and verified live');

  ctx.state.remapKeys = remapKeys;
}
