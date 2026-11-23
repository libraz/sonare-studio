/** Input monitor: the mic is audible only while monitoring. */
export const name = 'input-monitor';

export async function run(ctx) {
  const { page, fail } = ctx;

  {
    // The previous scenario's tail decays on the master meter first.
    await page
      .waitForFunction(
        () => {
          const peak = window.__sonareDebug.meterPeakDb();
          return peak === null || peak <= -90;
        },
        null,
        { timeout: 3000 },
      )
      .catch(() => undefined);
    const idleBefore = await page.evaluate(() => window.__sonareDebug.meterPeakDb());
    if (idleBefore !== null && idleBefore > -90) {
      fail(`engine not silent before the monitor check: peak ${idleBefore} dB`);
    }
    await page.evaluate(() => window.__sonareDebug.setInputMonitor(true));
    await page.waitForFunction(
      () => {
        const peak = window.__sonareDebug.meterPeakDb();
        return peak !== null && peak > -60;
      },
      null,
      { timeout: 5000 },
    );
    await page.evaluate(() => window.__sonareDebug.setInputMonitor(false));
    await page.waitForFunction(
      () => {
        const peak = window.__sonareDebug.meterPeakDb();
        return peak !== null && peak <= -90;
      },
      null,
      { timeout: 5000 },
    );
    console.info('input monitor: fake mic audible only while monitoring is enabled');
  }
}
