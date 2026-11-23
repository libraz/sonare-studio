import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';

/**
 * Master fader: typing a lower gain into the master strip's readout while the
 * project plays lowers the master meter's momentary loudness and true peak by
 * that amount, and lowers the offline mixdown's peak by the same amount. The
 * project has no master insert, so nothing but the fader stands between the
 * track and the output.
 */
export const name = 'master-fader';

export const knownEngineDefect =
  'a master fader set is dropped while no master strip has been configured on the engine';

const TRACK = 'Master fader tone';
const DROP_DB = 12;
const TOLERANCE_DB = 1.5;
const SAMPLES = 6;
const RANGE = { startPpq: 0, endPpq: 8 };

const readout = (page) =>
  page.evaluate(() => {
    const read = (selector) => {
      const text = document.querySelector(`.master-strip .master-meter ${selector}`)?.textContent;
      const value = Number.parseFloat((text ?? '').replace('−', '-'));
      return Number.isFinite(value) ? value : null;
    };
    return { momentary: read('.mm-cell .mm-value'), truePeak: read('.mm-tp .mm-value') };
  });

/** Median of several reads, so one refresh between two meter frames cannot decide. */
async function settled(page, key) {
  const values = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const value = (await readout(page))[key];
    if (value !== null) values.push(value);
    await page.waitForTimeout(200);
  }
  values.sort((a, b) => a - b);
  return values.length === 0 ? null : values[Math.floor(values.length / 2)];
}

const mixdownPeak = async (page) =>
  (await page.evaluate((range) => window.__sonareDebug.exportProbe(true, range), RANGE)).peakDb;

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await openEmptyProject(page, baseUrl);
    await skipTour(page);
    await page.click('.dock-tabs button:has-text("Mixer")');
    await page.click('.transport-bar .transport-key.play');
    await page.waitForFunction(() => window.__sonareDebug.engineStarted(), null, {
      timeout: 15000,
    });
    await page.evaluate(async (trackName) => {
      const id = window.__sonareDebug.addAudioTrack(trackName);
      await window.__sonareDebug.addToneClip(id, 60, 440, 0.5, 0);
    }, TRACK);
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });
    await page.waitForFunction(() => (window.__sonareDebug.meterPeakDb() ?? -120) > -20, null, {
      timeout: 15000,
    });
    await page.waitForTimeout(1500);
    const lufsOpen = await settled(page, 'momentary');
    const peakOpen = await settled(page, 'truePeak');
    const mixOpen = await mixdownPeak(page);

    const master = page.locator('.channel-strip.master-strip');
    await master.locator('.strip-readout').click();
    await master.locator('.numeric-readout-input').fill(String(-DROP_DB));
    await page.keyboard.press('Enter');
    const faderDb = await page.evaluate(
      () => window.__sonareDebug.projectDocument().mixer?.master?.gainDb ?? null,
    );
    if (faderDb === null || Math.abs(faderDb + DROP_DB) > 0.01) {
      fail(`the master readout did not set the fader to -${DROP_DB} dB: ${faderDb}`);
      return;
    }
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });
    await page.waitForTimeout(2000);
    const lufsLow = await settled(page, 'momentary');
    const peakLow = await settled(page, 'truePeak');
    const mixLow = await mixdownPeak(page);

    const deltas = {
      momentary: lufsLow - lufsOpen,
      truePeak: peakLow - peakOpen,
      mixdown: mixLow - mixOpen,
    };
    for (const [what, delta] of Object.entries(deltas)) {
      if (!Number.isFinite(delta) || Math.abs(delta + DROP_DB) > TOLERANCE_DB) {
        fail(`${what} moved ${delta.toFixed(2)} dB for a -${DROP_DB} dB master fader`);
      }
    }
    console.info(
      `master fader -${DROP_DB} dB: momentary ${deltas.momentary.toFixed(2)} dB, ` +
        `true peak ${deltas.truePeak.toFixed(2)} dB, mixdown ${deltas.mixdown.toFixed(2)} dB`,
    );
    await page.click('.transport-bar .transport-key.stop');
  } finally {
    await context.close();
  }
}
