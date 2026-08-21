import { laneMeterSampler } from '../harness.mjs';

/** Automation write/read modes: latch records a drag, read follows. */
export const name = 'automation-write';

export async function run(ctx) {
  const { page, fail } = ctx;
  const { rampTrackId } = ctx.state;
  // Read the arrangement box here rather than inheriting one measured in
  // an earlier scenario: the layout moves as scenarios add tracks.
  const rulerBox = await page.locator('.arrangement-canvas').boundingBox();
  const sampleWindow = laneMeterSampler(page, rampTrackId);

  // The previous scenario removed the lane, so the write drag starts clean.
  const lanePointsBefore = await page.evaluate(
    (id) => window.__sonareDebug.automationLanePoints(id, 'faderDb'),
    rampTrackId,
  );
  if (lanePointsBefore.length !== 0) {
    fail(`fader lane present before the write test: ${JSON.stringify(lanePointsBefore)}`);
  }

  await page.click('.dock-tabs button:has-text("Mixer")');
  await page.waitForSelector('.mixer-strips .channel-strip', { timeout: 10000 });
  const stripIndex = await page.evaluate(
    (id) => window.__sonareDebug.trackIds().indexOf(id),
    rampTrackId,
  );
  const writeStrip = page.locator('.mixer-strips .channel-strip').nth(stripIndex);
  // The strip offers R / T / L, not a single W: the write-class modes are
  // Touch and Latch. Latch is the one that keeps writing after the pointer
  // comes up, so the whole pass is recorded rather than just the drag.
  await writeStrip.locator('.strip-auto-l').click();
  await writeStrip.locator('.strip-auto-l.on').waitFor({ state: 'visible', timeout: 5000 });
  console.info('strip automation latch (write) mode engaged');

  // The fader's lower throw sits below the default 720px viewport fold, where
  // synthetic pointer events are silently dropped. Enlarge the viewport for
  // the drag and restore it at the end of the scenario.
  const savedViewport = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 960 });
  await writeStrip.locator('.fader-track').scrollIntoViewIfNeeded();

  // Record a rising fader drag across one loop pass ([0, 4) is 2 s at 120 BPM):
  // from ~10% of the throw (deep cut) up to ~75% (around unity).
  const faderBox = await writeStrip.locator('.fader-track').boundingBox();
  const faderX = faderBox.x + faderBox.width / 2;
  const dragYAt = (t) => faderBox.y + faderBox.height * (0.9 - 0.65 * t);
  await page.evaluate(() => window.__sonareDebug.setLoopRange(0, 4, true));
  await page.mouse.click(rulerBox.x + 2, rulerBox.y + 14); // playhead to PPQ 0
  await page.click('.transport-bar .transport-key.play');
  await page.waitForFunction(() => window.__sonareDebug.positionPpq() < 0.4, null, {
    timeout: 10000,
  });
  await page.mouse.move(faderX, dragYAt(0));
  await page.mouse.down();
  const dragSteps = 8;
  for (let i = 1; i <= dragSteps; i++) {
    await page.mouse.move(faderX, dragYAt(i / dragSteps));
    await page.waitForTimeout(160);
  }
  await page.mouse.up();
  await page.click('.transport-bar .transport-key.stop');

  // The drag must have produced a multi-point lane, and stop drops the
  // write-class mode back to read.
  const writtenPoints = await page.evaluate(
    (id) => window.__sonareDebug.automationLanePoints(id, 'faderDb'),
    rampTrackId,
  );
  if (writtenPoints.length < 2) {
    fail(`write drag recorded ${writtenPoints.length} point(s)`);
  }
  await writeStrip.locator('.strip-auto-r.on').waitFor({ state: 'visible', timeout: 5000 });
  const modeAfterStop = await page.evaluate(
    (id) => window.__sonareDebug.stripAutomationMode(id),
    rampTrackId,
  );
  if (modeAfterStop !== 'read') {
    fail(`stop did not drop write mode to read: mode ${modeAfterStop}`);
  }

  // Read-follow: the recorded ramp shapes the next loop pass audibly.
  await page.waitForFunction(
    () => window.__sonareDebug.automationInstalledParamIds().length >= 1,
    null,
    { timeout: 5000 },
  );
  await page.mouse.click(rulerBox.x + 2, rulerBox.y + 14);
  await page.click('.transport-bar .transport-key.play');
  const writeEarlyDb = await sampleWindow(0.5, 1.1);
  const writeLateDb = await sampleWindow(3.3, 3.9);
  if (writeEarlyDb === null || writeLateDb === null || writeLateDb - writeEarlyDb < 6) {
    fail(
      `recorded ramp not audible in read mode: early ${writeEarlyDb} dB, late ${writeLateDb} dB`,
    );
  }
  console.info(
    `PASS automation write/read modes: ${writtenPoints.length} points recorded, ` +
      `read-follow early ${writeEarlyDb.toFixed(1)} dB -> late ${writeLateDb.toFixed(1)} dB`,
  );

  await page.click('.transport-bar .transport-key.stop');
  await page.evaluate((id) => {
    window.__sonareDebug.removeAutomationLane(id, 'faderDb');
    window.__sonareDebug.setStripAutomationMode(id, 'off');
    window.__sonareDebug.setLoopRange(0, 4, false);
  }, rampTrackId);
  if (savedViewport) await page.setViewportSize(savedViewport);
}
