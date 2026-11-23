import { fileURLToPath } from 'node:url';
import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';

/**
 * Multi-timbral SF2: the Multi-timbral switch and channel map of the SF2 tab
 * give channel 2 and the drum channel their own programs, so notes on three
 * channels render differently than under the single track program.
 */
export const name = 'multi-timbral';

const sf2Path = fileURLToPath(new URL('../fixtures/minimal_gs.sf2', import.meta.url));
const MELODIC_CHANNEL = 1;
const PROGRAM = 24;
const DRUM_CHANNEL = 9;
const NOTES = [
  { pitch: 60, startPpq: 0, durationPpq: 1, channel: 0 },
  { pitch: 67, startPpq: 1, durationPpq: 1, channel: MELODIC_CHANNEL },
  { pitch: 38, startPpq: 2, durationPpq: 1, channel: DRUM_CHANNEL },
];

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await openEmptyProject(page, baseUrl);
    await skipTour(page);
    await page.evaluate(
      (seed) => window.__sonareDebug.addNotedMidiClip('Multi-timbral', 0, 4, seed),
      NOTES,
    );
    const probe = (startPpq, endPpq) =>
      page.evaluate((range) => window.__sonareDebug.exportProbe(false, range), {
        startPpq,
        endPpq,
      });
    const instrument = () =>
      page.evaluate(
        () =>
          window.__sonareDebug.projectDocument().tracks.find((t) => t.name === 'Multi-timbral')
            ?.instrument ?? null,
      );
    const settle = () =>
      page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
        timeout: 30000,
      });

    // Bind the SoundFont to the track as a single-timbral instrument.
    await page.click('.app-bar .devices-toggle');
    await page.locator('.device-rack .instrument-button').click();
    await page.locator('.instrument-picker .picker-tab').filter({ hasText: 'SF2' }).click();
    await page.locator('.instrument-picker .load-sf2-input').setInputFiles(sf2Path);
    await page.locator('.instrument-picker .font-option').first().click();
    await page.locator('.instrument-picker .use-sf2').click();
    await page.waitForFunction(
      () => window.__sonareDebug.trackInstruments().includes('sf2'),
      null,
      {
        timeout: 30000,
      },
    );
    await settle();
    const single = await probe(0, 3);
    const singleAgain = await probe(0, 3);
    if (single.hash !== singleAgain.hash || !(single.peakDb > -60)) {
      fail(
        `the single-timbral render is not stable audio: ${JSON.stringify([single, singleAgain])}`,
      );
    }

    // Turn the switch on and give channel 2 its own program; the drum channel keeps its kit.
    await page.locator('.device-rack .instrument-button').click();
    await page.locator('.instrument-picker .sf2-multitimbral-toggle input').check();
    const rows = page.locator('.instrument-picker .sf2-channel-row');
    const layout = {
      rows: await rows.count(),
      names: (await rows.locator('.sf2-channel-name').allTextContents()).map((n) => n.trim()),
      tagged: (await rows.locator('.sf2-channel-tag').allTextContents()).map((n) => n.trim()),
      drumTag: (
        (await rows.nth(DRUM_CHANNEL).locator('.sf2-channel-tag').textContent()) ?? ''
      ).trim(),
    };
    if (
      layout.rows !== 16 ||
      layout.names[DRUM_CHANNEL] !== 'Ch 10' ||
      layout.tagged.length !== 1 ||
      layout.drumTag !== 'Drums'
    ) {
      fail(
        `the channel map does not list 16 channels with Ch 10 as drums: ${JSON.stringify(layout)}`,
      );
    }
    await rows.nth(MELODIC_CHANNEL).locator('.sf2-channel-toggle input').check();
    await rows.nth(MELODIC_CHANNEL).locator('.sf2-channel-program').fill(String(PROGRAM));
    await rows.nth(DRUM_CHANNEL).locator('.sf2-channel-toggle input').check();
    await page.locator('.instrument-picker .use-sf2').click();
    await settle();
    const map = (await instrument())?.channelMap ?? [];
    const melodic = map.find((entry) => entry.channel === MELODIC_CHANNEL);
    const drums = map.find((entry) => entry.channel === DRUM_CHANNEL);
    if (melodic?.program !== PROGRAM || drums === undefined) {
      fail(`the channel map was not stored: ${JSON.stringify(map)}`);
    }
    const multi = await probe(0, 3);
    if (multi.hash === single.hash || !(multi.peakDb > -60)) {
      fail(`the channel map did not change the render: ${single.hash} -> ${multi.hash}`);
    } else {
      console.info(
        `multi-timbral: ${single.hash} (${single.peakDb.toFixed(1)} dB) -> ` +
          `${multi.hash} (${multi.peakDb.toFixed(1)} dB)`,
      );
    }
  } finally {
    await context.close();
  }
}
