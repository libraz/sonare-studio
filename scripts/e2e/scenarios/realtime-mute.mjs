/** Realtime mixer: mute silences playback without re-scheduling. */
export const name = 'realtime-mute';

export async function run(ctx) {
  const { page, fail } = ctx;

  const rulerBox = await page.locator('.arrangement-canvas').boundingBox();
  await page.mouse.click(rulerBox.x + 2, rulerBox.y + 14); // seek to the clips at PPQ 0
  await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
    timeout: 10000,
  });
  const scheduledBeforeMute = await page.evaluate(() => window.__sonareDebug.scheduledClipIds());
  await page.click('.transport-bar .transport-key.play');
  await page.waitForFunction(
    () => {
      const peak = window.__sonareDebug.meterPeakDb();
      return peak !== null && peak > -90;
    },
    null,
    { timeout: 5000 },
  );
  const muteToggles = page.locator('.mixer-strips .channel-strip .toggle.mute');
  const muteToggleCount = await muteToggles.count();
  for (let i = 0; i < muteToggleCount; i++) await muteToggles.nth(i).click();
  await page.waitForFunction(
    () => {
      const peak = window.__sonareDebug.meterPeakDb();
      return peak !== null && peak <= -90;
    },
    null,
    { timeout: 3000 },
  );
  await page.click('.transport-bar .transport-key.stop');
  const scheduledAfterMute = await page.evaluate(() => window.__sonareDebug.scheduledClipIds());
  const pendingAfterMute = await page.evaluate(() => window.__sonareDebug.applyPending());
  if (
    pendingAfterMute ||
    JSON.stringify(scheduledBeforeMute) !== JSON.stringify(scheduledAfterMute)
  ) {
    fail(
      `mute caused a re-schedule: pending=${pendingAfterMute}, clips ${scheduledBeforeMute.length} -> ${scheduledAfterMute.length}`,
    );
  }
  for (let i = 0; i < muteToggleCount; i++) await muteToggles.nth(i).click();
  await page.waitForTimeout(200);
  console.info('realtime mute: master silenced without re-scheduling');
}
