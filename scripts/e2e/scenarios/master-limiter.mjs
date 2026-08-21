/** Realtime strip DSP: a master limiter is audible live and in the export. */
export const name = 'master-limiter';

export async function run(ctx) {
  const { page, fail } = ctx;

  {
    const masterInsertsBefore = await page.evaluate(() => window.__sonareDebug.masterInsertCount());
    if (masterInsertsBefore !== 0) {
      fail(`expected an empty master insert chain, got ${masterInsertsBefore}`);
    }
    const rulerBox4 = await page.locator('.arrangement-canvas').boundingBox();
    await page.mouse.click(rulerBox4.x + 2, rulerBox4.y + 14); // seek to PPQ 0
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 10000,
    });
    const idsBeforeStrip = await page.evaluate(() =>
      JSON.stringify(window.__sonareDebug.scheduledClipIds()),
    );
    await page.click('.transport-bar .transport-key.play');
    await page.waitForFunction(
      () => {
        const peak = window.__sonareDebug.meterPeakDb();
        return peak !== null && peak > -90;
      },
      null,
      { timeout: 5000 },
    );
    // The fixed thresholds below assume a healthy playback level; sample the
    // meter briefly to prove the premise.
    let peakBefore = -120;
    for (let i = 0; i < 8; i++) {
      const peak = await page.evaluate(() => window.__sonareDebug.meterPeakDb());
      if (peak !== null && peak > peakBefore) peakBefore = peak;
      await page.waitForTimeout(100);
    }
    if (peakBefore <= -40) {
      fail(`playback too quiet for the limiter check: peak ${peakBefore.toFixed(1)} dB`);
    }

    // A brickwall limiter with a -60 dB ceiling must cap the master output
    // immediately, with no re-schedule.
    await page.evaluate(() =>
      window.__sonareDebug.addMasterInsert('dynamics.brickwallLimiter', { ceilingDb: -60 }),
    );
    await page.waitForFunction(
      () => {
        const peak = window.__sonareDebug.meterPeakDb();
        return peak !== null && peak <= -50;
      },
      null,
      { timeout: 5000 },
    );
    const peakLimited = await page.evaluate(() => window.__sonareDebug.meterPeakDb());

    // Bypassing the limiter must restore the level, still without re-scheduling.
    await page.evaluate(() => window.__sonareDebug.setMasterInsertEnabled(0, false));
    await page.waitForFunction(
      () => {
        const peak = window.__sonareDebug.meterPeakDb();
        return peak !== null && peak > -45;
      },
      null,
      { timeout: 5000 },
    );
    await page.evaluate(() => window.__sonareDebug.setMasterInsertEnabled(0, true));
    await page.waitForFunction(
      () => {
        const peak = window.__sonareDebug.meterPeakDb();
        return peak !== null && peak <= -50;
      },
      null,
      { timeout: 5000 },
    );
    await page.click('.transport-bar .transport-key.stop');

    const stripState = await page.evaluate(() => ({
      pending: window.__sonareDebug.applyPending(),
      ids: JSON.stringify(window.__sonareDebug.scheduledClipIds()),
    }));
    if (stripState.pending || stripState.ids !== idsBeforeStrip) {
      fail(`master insert edits caused a re-schedule: pending=${stripState.pending}`);
    }
    console.info(
      `realtime master limiter: live peak capped to ${peakLimited?.toFixed(1)} dB without re-scheduling`,
    );

    // Chain equivalence: the offline export must apply the same limiter and
    // land in the same loudness ballpark as the live engine.
    const exportLimited = await page.evaluate(() => window.__sonareDebug.exportProbe(true));
    if (exportLimited.peakDb > -50 || exportLimited.peakDb < -75) {
      fail(`export ignored the master limiter: peak ${exportLimited.peakDb} dB`);
    }
    if (peakLimited !== null && Math.abs(exportLimited.peakDb - peakLimited) > 8) {
      fail(
        `realtime vs export diverge: live ${peakLimited.toFixed(1)} dB, export ${exportLimited.peakDb.toFixed(1)} dB`,
      );
    }
    console.info(
      `chain equivalence: live ${peakLimited?.toFixed(1)} dB vs export ${exportLimited.peakDb.toFixed(1)} dB`,
    );
    await page.evaluate(() => window.__sonareDebug.removeMasterInsert(0));
    await page.waitForFunction(() => window.__sonareDebug.masterInsertCount() === 0, null, {
      timeout: 5000,
    });
  }
}
