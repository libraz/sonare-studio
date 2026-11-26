/** Tempo map: segments drive the engine timeline and the playhead. */
export const name = 'tempo-map';

export async function run(ctx) {
  const { page, fail } = ctx;

  {
    await page.evaluate(() =>
      window.__sonareDebug.setTempoSegments([
        { startPpq: 0, bpm: 120 },
        { startPpq: 4, bpm: 60 },
      ]),
    );
    // A tempo change re-bounces audio clips; let it settle.
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });
    const rulerBox7 = await page.locator('.arrangement-canvas').boundingBox();
    await page.mouse.click(rulerBox7.x + 2, rulerBox7.y + 14);
    await page.click('.transport-bar .transport-key.play');
    // Use the audio clock: the worklet can render slower than wall time in headless runs.
    const fastStart = await page.evaluate(() => window.__sonareDebug.playheadClock());
    await page.waitForTimeout(1500);
    const fastEnd = await page.evaluate(() => window.__sonareDebug.playheadClock());
    const fastRate =
      (fastEnd.ppq - fastStart.ppq) / (fastEnd.audioSeconds - fastStart.audioSeconds);
    if (!(fastRate > 1.4 && fastRate < 2.6)) {
      fail(`playhead rate in the 120 BPM region off: ${fastRate.toFixed(2)} PPQ/s`);
    }
    // 60 BPM region: ~1 PPQ per second once past the segment boundary.
    await page.waitForFunction(() => window.__sonareDebug.positionPpq() > 4.5, null, {
      timeout: 8000,
    });
    const slowStart = await page.evaluate(() => window.__sonareDebug.playheadClock());
    await page.waitForTimeout(1500);
    const slowEnd = await page.evaluate(() => window.__sonareDebug.playheadClock());
    const slowRate =
      (slowEnd.ppq - slowStart.ppq) / (slowEnd.audioSeconds - slowStart.audioSeconds);
    if (!(slowRate > 0.6 && slowRate < 1.4)) {
      fail(`playhead rate in the 60 BPM region off: ${slowRate.toFixed(2)} PPQ/s`);
    }
    await page.click('.transport-bar .transport-key.stop');
    console.info(
      `tempo map followed: ${fastRate.toFixed(2)} PPQ/s at 120 BPM, ${slowRate.toFixed(2)} PPQ/s at 60 BPM`,
    );

    // Loop boundaries hold under the tempo map.
    await page.evaluate(() => window.__sonareDebug.setLoopRange(0, 4, true));
    await page.mouse.click(rulerBox7.x + 2, rulerBox7.y + 14);
    await page.click('.transport-bar .transport-key.play');
    await page.waitForTimeout(3000);
    const loopedPpq = await page.evaluate(() => window.__sonareDebug.positionPpq());
    if (!(loopedPpq >= 0 && loopedPpq < 4.4)) {
      fail(`loop did not wrap at the segment tempo: position ${loopedPpq.toFixed(2)} PPQ`);
    }
    await page.click('.transport-bar .transport-key.stop');
    await page.evaluate(() => window.__sonareDebug.setLoopRange(0, 4, false));
    console.info(`loop wrapped inside [0, 4): position ${loopedPpq.toFixed(2)} PPQ`);

    // Restore the constant demo tempo for the remaining scenarios.
    await page.evaluate(() => window.__sonareDebug.setTempoSegments([{ startPpq: 0, bpm: 120 }]));
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });
  }
}
