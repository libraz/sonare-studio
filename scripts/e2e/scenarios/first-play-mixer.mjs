import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';

/**
 * First-play mixer: a clip added before the engine exists, then Play. The
 * track's fader and mute must reach the engine on that first run, so the master
 * meter follows a gain change and falls silent on mute without a restart.
 */
export const name = 'first-play-mixer';

const TRACK = 'First play tone';
const DROP_DB = 12;
const TOLERANCE_DB = 1.5;
const SAMPLES = 6;
const SILENT_DB = -60;

const peakDb = (page) => page.evaluate(() => window.__sonareDebug.meterPeakDb() ?? -120);

/** Median of several reads, so one refresh between two meter frames cannot decide. */
async function settledPeak(page) {
  const values = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    values.push(await peakDb(page));
    await page.waitForTimeout(200);
  }
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await openEmptyProject(page, baseUrl);
    await skipTour(page);
    // The clip exists before the engine does; the first Play starts it.
    if (await page.evaluate(() => window.__sonareDebug.engineStarted())) {
      fail('the engine already runs before the first Play');
    }
    await page.evaluate(async (trackName) => {
      const id = window.__sonareDebug.addAudioTrack(trackName);
      await window.__sonareDebug.addToneClip(id, 60, 440, 0.5, 0);
    }, TRACK);
    await page.click('.dock-tabs button:has-text("Mixer")');
    await page.click('.transport-bar .transport-key.play');
    await page.waitForFunction(() => window.__sonareDebug.engineStarted(), null, {
      timeout: 15000,
    });
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });
    await page.waitForFunction(() => (window.__sonareDebug.meterPeakDb() ?? -120) > -20, null, {
      timeout: 15000,
    });
    await page.waitForTimeout(1000);
    const open = await settledPeak(page);

    const trackStrip = page.locator('.channel-strip:not(.master)', { hasText: TRACK });
    await trackStrip.locator('.strip-readout').click();
    await trackStrip.locator('.numeric-readout-input').fill(String(-DROP_DB));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    const low = await settledPeak(page);
    if (Math.abs(low - open + DROP_DB) > TOLERANCE_DB) {
      fail(
        `the master peak moved ${(low - open).toFixed(1)} dB for a -${DROP_DB} dB fader ` +
          `on the first run (${open.toFixed(1)} -> ${low.toFixed(1)} dBFS)`,
      );
    }

    await trackStrip.locator('.toggle.mute').click();
    await page.waitForTimeout(1500);
    const muted = await settledPeak(page);
    if (!(muted < SILENT_DB)) {
      fail(`the master peak reads ${muted.toFixed(1)} dBFS with the only track muted`);
    }
    await trackStrip.locator('.toggle.mute').click();
    await page.waitForTimeout(1500);
    const unmuted = await settledPeak(page);
    if (Math.abs(unmuted - low) > TOLERANCE_DB) {
      fail(`the master peak reads ${unmuted.toFixed(1)} dBFS after unmute, not ${low.toFixed(1)}`);
    }
    console.info(
      `first-play mixer: ${open.toFixed(1)} -> ${low.toFixed(1)} dBFS at -${DROP_DB} dB, ` +
        `muted ${muted.toFixed(1)}, unmuted ${unmuted.toFixed(1)}`,
    );
    await page.click('.transport-bar .transport-key.stop');
  } finally {
    await context.close();
  }
}
