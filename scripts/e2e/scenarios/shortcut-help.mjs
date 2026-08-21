/** Shortcut help overlay: '?' opens, Escape closes, focus returns. */
export const name = 'shortcut-help';

export async function run(ctx) {
  const { page, fail } = ctx;

  await page.click('.dock-tabs button:has-text("Piano Roll")');
  await page.keyboard.press('?');
  await page.waitForSelector('[role="dialog"][aria-label="Keyboard shortcuts"]', {
    timeout: 5000,
  });
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"][aria-label="Keyboard shortcuts"]', {
    state: 'detached',
    timeout: 5000,
  });
  const focusAfterHelp = await page.evaluate(() => document.activeElement?.textContent?.trim());
  if (focusAfterHelp !== 'Piano Roll') {
    fail(`focus did not return to the trigger after closing help: "${focusAfterHelp}"`);
  } else {
    console.info("shortcut help opened with '?', closed with Escape, focus restored");
  }
}
