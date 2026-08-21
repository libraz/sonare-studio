/** Named layouts: presets rearrange the workspace. */
export const name = 'layouts';

export async function run(ctx) {
  const { page, fail } = ctx;

  // Layout presets live in Settings > Layouts (not in the Window menu).
  await page.click('.app-menubar__trigger:has-text("Options")');
  await page
    .locator('.menu-panel [role="menuitem"]')
    .filter({ hasText: /^Settings/ })
    .click();
  await page.click('[role="dialog"][aria-label="Settings"] [role="tab"]:has-text("Layouts")');
  const layoutsPanel = page.locator('#settings-panel-layouts');
  await layoutsPanel
    .locator('.settings-row')
    .filter({ hasText: /^Mix/ })
    .getByRole('button')
    .click();
  await page.waitForFunction(
    () => document.querySelector('.arrange-zone')?.style.flexBasis === '300px',
    null,
    { timeout: 5000 },
  );
  const mixTabActive = await page.evaluate(() =>
    document.querySelector('.dock-tabs button.active')?.textContent?.trim(),
  );
  const rackOpenAfterMix = await page.evaluate(
    () => document.querySelector('.right-zone') !== null,
  );
  if (mixTabActive !== 'Mixer' || rackOpenAfterMix) {
    fail(`Mix layout not applied: tab=${mixTabActive} rackOpen=${rackOpenAfterMix}`);
  } else {
    console.info('Mix layout applied: mixer tab, 300px arrangement, rack closed');
  }
  await layoutsPanel
    .locator('.settings-row')
    .filter({ hasText: /^Compose/ })
    .getByRole('button')
    .click();
  await page.waitForSelector('.right-zone', { timeout: 5000 });
  const composeTabActive = await page.evaluate(() =>
    document.querySelector('.dock-tabs button.active')?.textContent?.trim(),
  );
  if (composeTabActive !== 'Piano Roll') {
    fail(`Compose layout not applied: tab=${composeTabActive}`);
  } else {
    console.info('Compose layout applied: piano roll tab, device rack open');
  }
  await page.click('[role="dialog"][aria-label="Settings"] button.primary:has-text("Close")');
  // Close the rack again so the device-rack step below starts from closed.
  await page.click('.app-bar .devices-toggle');
  await page.waitForSelector('.right-zone', { state: 'detached', timeout: 5000 });
}
