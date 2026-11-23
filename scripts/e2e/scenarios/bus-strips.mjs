import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';

/**
 * Bus strips: + Bus adds a strip, and the track strip's Output menu routes the
 * track into it. The bus return carries the track only after routing, the bus
 * fader sets the master mix level, and muting the bus silences the master mix.
 */
export const name = 'bus-strips';

const TRACK = 'Bus source';
const TONE_DB = -6.02;
const FADER_DB = -12;
const TOLERANCE_DB = 0.7;

const probe = (page, stems) =>
  page.evaluate(
    (withStems) => window.__sonareDebug.exportProbe(false, undefined, withStems, 0, withStems),
    stems,
  );

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await openEmptyProject(page, baseUrl);
    await skipTour(page);
    await page.evaluate(async (trackName) => {
      const id = window.__sonareDebug.addAudioTrack(trackName);
      await window.__sonareDebug.addToneClip(id, 2, 330, 0.5, 0);
    }, TRACK);
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });

    await page.click('.dock-tabs button:has-text("Mixer")');
    await page.locator('.mixer-toolbar .toolbar-button', { hasText: '+ Bus' }).click();
    const busStrip = page.locator('.mixer-strips .bus-strip');
    await busStrip.waitFor({ state: 'visible', timeout: 10000 });
    const busName = ((await busStrip.locator('.bus-name').textContent()) ?? '').trim();
    const returnPeak = async () => {
      const stem = (await probe(page, true)).stems?.find((s) => s.name === `${busName} Return`);
      if (!stem) throw new Error(`no return stem for ${busName}`);
      return stem.peakDb;
    };
    const before = await returnPeak();
    if (!(before < -90)) fail(`the unrouted bus carries ${before} dB`);

    // Route the track into the bus from its Output menu.
    const trackStrip = page.locator('.channel-strip:not(.master)', { hasText: TRACK });
    await trackStrip.locator(`[aria-label="Output bus for ${TRACK}"]`).click();
    await page.locator('.select-list [role="option"]', { hasText: busName }).click();
    const routed = await page.evaluate(() => {
      const doc = window.__sonareDebug.projectDocument();
      return { buses: doc.mixer.buses.map((b) => b.id), out: doc.tracks[0].mixer?.outputBusId };
    });
    if (routed.buses.length !== 1 || routed.out !== routed.buses[0]) {
      fail(`the track output is not the bus: ${JSON.stringify(routed)}`);
    }
    const received = await returnPeak();
    if (Math.abs(received - TONE_DB) > TOLERANCE_DB) {
      fail(`the bus return carries ${received.toFixed(2)} dB, expected ${TONE_DB} dB`);
    }
    const open = (await probe(page, false)).peakDb;
    if (Math.abs(open - TONE_DB) > TOLERANCE_DB) fail(`master mix via the bus is ${open} dB`);

    // The bus fader and mute shape what the master receives.
    await busStrip.locator('.bus-readout').click();
    await busStrip.locator('.numeric-readout-input').fill(String(FADER_DB));
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (db) => window.__sonareDebug.projectDocument().mixer.buses[0]?.gainDb === db,
      FADER_DB,
      { timeout: 5000 },
    );
    const lowered = (await probe(page, false)).peakDb;
    if (Math.abs(lowered - open - FADER_DB) > TOLERANCE_DB) {
      fail(`a ${FADER_DB} dB bus fader moved the master mix ${(lowered - open).toFixed(2)} dB`);
    }
    await busStrip.locator('.bus-toggle.mute').click();
    const muted = (await probe(page, false)).peakDb;
    if (!(muted < -90)) fail(`the master mix carries ${muted} dB with the bus muted`);
    console.info(
      `bus strip: return ${before <= -120 ? 'silent' : before.toFixed(1)} -> ${received.toFixed(1)} dB, ` +
        `master ${open.toFixed(1)} -> ${lowered.toFixed(1)} dB at ${FADER_DB} dB, muted ${muted.toFixed(0)} dB`,
    );
  } finally {
    await context.close();
  }
}
