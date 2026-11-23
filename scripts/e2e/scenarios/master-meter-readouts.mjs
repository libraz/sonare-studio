import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';

/**
 * Master meter readouts: while the project plays, the master strip shows
 * momentary, short-term and integrated LUFS and the true peak. Typing a lower
 * gain into the playing track's strip lowers the momentary and true-peak
 * readings by that amount, and a master limiter makes the gain-reduction row
 * appear.
 */
export const name = 'master-meter-readouts';

const TRACK = 'Meter tone';
const DROP_DB = 12;
const TOLERANCE_DB = 1.5;
const SAMPLES = 6;

const readout = (page) =>
  page.evaluate(() => {
    const read = (selector) => {
      const text = document.querySelector(`.master-strip .master-meter ${selector}`)?.textContent;
      const value = Number.parseFloat((text ?? '').replace('−', '-'));
      return Number.isFinite(value) ? value : null;
    };
    const cells = [...document.querySelectorAll('.master-strip .master-meter .mm-cell')].map(
      (cell) => ({
        label: cell.querySelector('.mm-label')?.textContent?.trim() ?? '',
        value: Number.parseFloat(cell.querySelector('.mm-value')?.textContent ?? ''),
      }),
    );
    return {
      cells,
      truePeak: read('.mm-tp .mm-value'),
      gainReduction: document.querySelector('.master-strip .master-meter .mm-gr')
        ? Math.abs(read('.mm-gr .mm-value') ?? Number.NaN)
        : null,
    };
  });

/** Median of several reads, so one refresh between two meter frames cannot decide. */
async function settled(page, pick) {
  const values = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const value = pick(await readout(page));
    if (value !== null && Number.isFinite(value)) values.push(value);
    await page.waitForTimeout(200);
  }
  values.sort((a, b) => a - b);
  return values.length === 0 ? null : values[Math.floor(values.length / 2)];
}

const momentary = (r) => r.cells[0]?.value ?? null;

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await openEmptyProject(page, baseUrl);
    await skipTour(page);
    // The engine starts on the first Play; the track joins it while it runs.
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
    await page.locator('.master-strip .master-meter').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(
      () => {
        const first = document.querySelector('.master-strip .master-meter .mm-cell .mm-value');
        return Number.isFinite(Number.parseFloat(first?.textContent ?? ''));
      },
      null,
      { timeout: 15000 },
    );
    await page.waitForFunction(() => (window.__sonareDebug.meterPeakDb() ?? -120) > -20, null, {
      timeout: 15000,
    });
    await page.waitForTimeout(1500);

    const open = await readout(page);
    const labels = open.cells.map((cell) => cell.label);
    if (labels.length !== 3 || open.cells.some((cell) => !Number.isFinite(cell.value))) {
      fail(`the LUFS readouts are not all numeric: ${JSON.stringify(open.cells)}`);
    }
    if (open.truePeak === null || open.gainReduction !== null) {
      fail(`unexpected true peak ${open.truePeak} / gain reduction ${open.gainReduction}`);
    }
    const lufsOpen = await settled(page, momentary);
    const peakOpen = await settled(page, (r) => r.truePeak);
    if (!(lufsOpen > -40 && lufsOpen < 0) || !(peakOpen > -20 && peakOpen < 3)) {
      fail(`implausible readings for a -6 dBFS tone: ${lufsOpen} LUFS, ${peakOpen} dBTP`);
    }

    // Lower the track's fader through its gain readout while the transport runs.
    const trackStrip = page.locator('.channel-strip:not(.master)', { hasText: TRACK });
    await trackStrip.locator('.strip-readout').click();
    await trackStrip.locator('.numeric-readout-input').fill(String(-DROP_DB));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    const lufsLow = await settled(page, momentary);
    const peakLow = await settled(page, (r) => r.truePeak);
    const lufsDelta = lufsLow - lufsOpen;
    const peakDelta = peakLow - peakOpen;
    if (Math.abs(lufsDelta + DROP_DB) > TOLERANCE_DB) {
      fail(`momentary LUFS moved ${lufsDelta.toFixed(1)} dB for a -${DROP_DB} dB track fader`);
    }
    if (Math.abs(peakDelta + DROP_DB) > TOLERANCE_DB) {
      fail(`true peak moved ${peakDelta.toFixed(1)} dB for a -${DROP_DB} dB track fader`);
    }

    // Back to unity, then a master limiter whose ceiling sits below the tone.
    await trackStrip.locator('.strip-readout').click();
    await trackStrip.locator('.numeric-readout-input').fill('0');
    await page.keyboard.press('Enter');
    await page.evaluate(() =>
      window.__sonareDebug.addMasterInsert('dynamics.brickwallLimiter', { ceilingDb: -20 }),
    );
    await page
      .locator('.master-strip .master-meter .mm-gr')
      .waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(1000);
    const reduction = await settled(page, (r) => r.gainReduction);
    if (!(reduction > 3))
      fail(`the gain-reduction readout shows ${reduction} dB under a -20 dB ceiling`);
    console.info(
      `master meter: ${lufsOpen.toFixed(1)} -> ${lufsLow.toFixed(1)} LUFS, ` +
        `${peakOpen.toFixed(1)} -> ${peakLow.toFixed(1)} dBTP at -${DROP_DB} dB, ` +
        `gain reduction ${reduction.toFixed(1)} dB`,
    );
    await page.click('.transport-bar .transport-key.stop');
  } finally {
    await context.close();
  }
}
