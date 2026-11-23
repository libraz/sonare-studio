import { laneMeterSampler, makeWavBytes } from '../harness.mjs';

/** Automation volume ramp: a fader lane shapes the loop. */
export const name = 'automation-ramp';

export async function run(ctx) {
  const { page, fail } = ctx;

  {
    // A steady looping source: a 2 s tone spans exactly [0, 4) PPQ at 120 BPM.
    const rampWav = {
      name: 'sonare-e2e-ramp-tone.wav',
      mimeType: 'audio/wav',
      buffer: makeWavBytes(2, 330),
    };
    const rulerBox = await page.locator('.arrangement-canvas').boundingBox();
    await page.mouse.click(rulerBox.x + 2, rulerBox.y + 14); // playhead to PPQ 0
    await page.click('.dock-tabs button:has-text("Media")');
    const tracksBeforeRamp = await page.evaluate(() => window.__sonareDebug.trackIds());
    const clipsBeforeRamp = await page.evaluate(() => window.__sonareDebug.clipCount());
    await page.setInputFiles('.media-browser .file-input', rampWav);
    const rampRow = page.locator('.media-browser .asset-row', { hasText: 'sonare-e2e-ramp-tone' });
    await rampRow.first().waitFor({ state: 'visible', timeout: 20000 });
    await rampRow.first().locator('.add-button').click();
    await page.waitForFunction(
      (before) => window.__sonareDebug.clipCount() === before + 1,
      clipsBeforeRamp,
      { timeout: 10000 },
    );
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });
    const rampTrackId = await page.evaluate(
      (before) => window.__sonareDebug.trackIds().find((id) => !before.includes(id)),
      tracksBeforeRamp,
    );

    // Baseline: the steady track level over one loop pass with no automation.
    await page.evaluate(() => window.__sonareDebug.setLoopRange(0, 4, true));
    await page.mouse.click(rulerBox.x + 2, rulerBox.y + 14);
    await page.click('.transport-bar .transport-key.play');
    await page.waitForFunction(
      (id) => {
        const db = window.__sonareDebug.trackMeterDb(id);
        return db !== null && db > -90;
      },
      rampTrackId,
      { timeout: 5000 },
    );
    let baselineDb = -120;
    for (let i = 0; i < 10; i++) {
      const db = await page.evaluate((id) => window.__sonareDebug.trackMeterDb(id), rampTrackId);
      if (db !== null && db > baselineDb) baselineDb = db;
      await page.waitForTimeout(100);
    }
    if (baselineDb <= -40) {
      fail(`ramp source too quiet for the automation check: ${baselineDb.toFixed(1)} dB`);
    }

    // Install a -60 dB -> 0 dB fader ramp across the loop.
    await page.evaluate(
      (id) =>
        window.__sonareDebug.setAutomationLanePoints(id, 'faderDb', [
          { ppq: 0, value: -60 },
          { ppq: 4, value: 0 },
        ]),
      rampTrackId,
    );
    await page.waitForFunction(() => window.__sonareDebug.automationLaneCount() >= 1, null, {
      timeout: 5000,
    });
    const installedIds = await page.evaluate(() =>
      window.__sonareDebug.automationInstalledParamIds(),
    );
    if (installedIds.length < 1) {
      fail(`no automation lane installed in the engine: ${JSON.stringify(installedIds)}`);
    }

    const sampleWindow = laneMeterSampler(page, rampTrackId);
    const earlyDb = await sampleWindow(0.5, 1.1);
    const lateDb = await sampleWindow(3.3, 3.9);
    if (earlyDb === null || lateDb === null || lateDb - earlyDb < 15) {
      fail(`fader ramp not audible: early ${earlyDb} dB, late ${lateDb} dB`);
    }
    // After the loop wraps, the curve must reapply: early is quiet again.
    const earlyDb2 = await sampleWindow(0.5, 1.1);
    if (earlyDb2 === null || lateDb - earlyDb2 < 15) {
      fail(`ramp did not reapply after the loop wrap: early ${earlyDb2} dB vs late ${lateDb} dB`);
    }
    console.info(
      `PASS automation volume ramp: early ${earlyDb.toFixed(1)} dB -> late ${lateDb.toFixed(1)} dB, ` +
        `post-wrap early ${earlyDb2.toFixed(1)} dB`,
    );

    // Removing the lane must restore the manual fader level.
    await page.evaluate(
      (id) => window.__sonareDebug.removeAutomationLane(id, 'faderDb'),
      rampTrackId,
    );
    await page.waitForFunction(
      () => window.__sonareDebug.automationInstalledParamIds().length === 0,
      null,
      { timeout: 5000 },
    );
    // Let the lane meter's ballistics settle at the restored fader level.
    await page.waitForTimeout(600);
    let restoredDb = -120;
    for (let i = 0; i < 10; i++) {
      const db = await page.evaluate((id) => window.__sonareDebug.trackMeterDb(id), rampTrackId);
      if (db !== null && db > restoredDb) restoredDb = db;
      await page.waitForTimeout(100);
    }
    if (Math.abs(restoredDb - baselineDb) > 3) {
      fail(
        `level did not restore after lane removal: baseline ${baselineDb.toFixed(1)} dB, ` +
          `restored ${restoredDb.toFixed(1)} dB`,
      );
    }
    console.info(
      `PASS automation lane removed: level restored to ${restoredDb.toFixed(1)} dB ` +
        `(baseline ${baselineDb.toFixed(1)} dB)`,
    );
    await page.click('.transport-bar .transport-key.stop');
    await page.evaluate(() => window.__sonareDebug.setLoopRange(0, 4, false));
    ctx.state.rampTrackId = rampTrackId;
  }
}
