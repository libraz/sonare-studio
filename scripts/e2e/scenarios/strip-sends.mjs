import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';

/**
 * Sends: a bus added with + Bus and a level typed into a track strip's send
 * row create a send in the document. The bus return stem is silent before the
 * send, carries the track at the send level afterwards, and follows a lower
 * send level by the same number of dB.
 */
export const name = 'strip-sends';

const TRACK = 'Send source';
const TONE_DB = -6.02;
const SEND_DB = -6;
const LOWER_SEND_DB = -18;
const TOLERANCE_DB = 0.7;

const returnPeak = async (page, busName) => {
  const result = await page.evaluate(() =>
    window.__sonareDebug.exportProbe(false, undefined, true, 0, true),
  );
  const stem = result.stems?.find((entry) => entry.name === `${busName} Return`);
  if (!stem) throw new Error(`no return stem for ${busName}: ${JSON.stringify(result.stems)}`);
  return stem.peakDb;
};

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
    const silent = await returnPeak(page, busName);
    if (!(silent < -90)) fail(`the bus return carries ${silent} dB before any send exists`);

    // Typing a level into the send row of the track strip creates the send.
    const trackStrip = page.locator('.channel-strip:not(.master)', { hasText: TRACK });
    const row = trackStrip.locator('.send-row', { hasText: busName });
    const setSendLevel = async (db) => {
      await row.locator('.send-readout').click();
      await trackStrip.locator('.numeric-readout-input').fill(String(db));
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        (level) =>
          window.__sonareDebug
            .projectDocument()
            .tracks.some((track) => track.mixer?.sends?.some((send) => send.levelDb === level)),
        db,
        { timeout: 5000 },
      );
    };
    await setSendLevel(SEND_DB);
    const sends = await page.evaluate(() => {
      const doc = window.__sonareDebug.projectDocument();
      return {
        buses: doc.mixer.buses.map((bus) => bus.id),
        sends: doc.tracks.find((track) => track.mixer?.sends?.length)?.mixer.sends ?? [],
      };
    });
    if (
      sends.sends.length !== 1 ||
      sends.sends[0].busId !== sends.buses[0] ||
      sends.sends[0].enabled === false
    ) {
      fail(`the send was not stored against the bus: ${JSON.stringify(sends)}`);
    }

    const received = await returnPeak(page, busName);
    if (Math.abs(received - (TONE_DB + SEND_DB)) > TOLERANCE_DB) {
      fail(`the bus receives ${received.toFixed(2)} dB, expected ${TONE_DB + SEND_DB} dB`);
    }
    await setSendLevel(LOWER_SEND_DB);
    const lowered = await returnPeak(page, busName);
    const delta = lowered - received;
    if (Math.abs(delta - (LOWER_SEND_DB - SEND_DB)) > TOLERANCE_DB) {
      fail(
        `lowering the send by ${SEND_DB - LOWER_SEND_DB} dB moved the bus ${delta.toFixed(2)} dB`,
      );
    }
    console.info(
      `sends: bus ${silent <= -120 ? 'silent' : silent.toFixed(1)} -> ${received.toFixed(1)} dB at ` +
        `${SEND_DB} dB -> ${lowered.toFixed(1)} dB at ${LOWER_SEND_DB} dB`,
    );
  } finally {
    await context.close();
  }
}
