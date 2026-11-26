/** Edit the imported reference audio against the generated arrangement. */
export const name = 'pop-audio-adjust';

export async function run({ page, fail }) {
  const audio = (await page.evaluate(() => window.__sonareDebug.clipRanges())).find(
    (clip) => clip.kind === 'audio' && clip.startPpq === 0,
  );
  if (!audio) throw new Error('reference audio clip missing from generated song');
  await page.locator('.tool-palette .tool-button').first().click();
  const canvas = page.locator('.arrangement-canvas canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('arrangement canvas missing');
  const header = page.locator('.track-header').last();
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await header.boundingBox();
    if (row && row.y >= box.y + 28 && row.y + 20 < box.y + box.height) break;
    await page.mouse.move(box.x + 100, box.y + 160);
    await page.mouse.wheel(0, 180);
    await page.waitForTimeout(40);
  }
  const row = await header.boundingBox();
  if (!row || row.y < box.y + 28 || row.y + 20 >= box.y + box.height) {
    throw new Error(`reference audio lane could not be revealed: ${JSON.stringify(row)}`);
  }
  await page.mouse.click(box.x + 5, row.y + 20);
  const active = await page.evaluate(() => window.__sonareDebug.activeClipId());
  if (active !== audio.id) fail(`reference audio did not select for adjustment: ${active}`);
  const inspector = page.locator('.clip-inspector');
  await inspector.waitFor({ state: 'visible' });
  const fields = inspector.locator('.ci-field input');
  if ((await fields.count()) !== 3) throw new Error('audio clip gain/fade controls missing');

  await fields.nth(0).fill('-6');
  await fields.nth(0).press('Tab');
  await fields.nth(1).fill('0.25');
  await fields.nth(1).press('Tab');
  await fields.nth(2).fill('0.25');
  await fields.nth(2).press('Tab');
  const adjusted = await page.evaluate((id) => window.__sonareDebug.clipSettings(id), audio.id);
  if (
    !adjusted ||
    Math.abs(adjusted.gain - 0.501) > 0.01 ||
    adjusted.fadeInPpq !== 0.25 ||
    adjusted.fadeOutPpq !== 0.25
  ) {
    fail(`audio adjustments did not reach the clip: ${JSON.stringify(adjusted)}`);
  }

  for (let undo = 0; undo < 3; undo++) await page.keyboard.press('ControlOrMeta+z');
  const restored = await page.evaluate((id) => window.__sonareDebug.clipSettings(id), audio.id);
  if (
    !restored ||
    Math.abs(restored.gain - 1) > 0.001 ||
    (restored.fadeInPpq ?? 0) !== 0 ||
    (restored.fadeOutPpq ?? 0) !== 0
  ) {
    fail(
      `audio gain/fades were not undone together with their fields: ${JSON.stringify(restored)}`,
    );
  }
  console.info(
    'reference audio gain and both fades adjusted through the clip inspector, then undone',
  );
}
