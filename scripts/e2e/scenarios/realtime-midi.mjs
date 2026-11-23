/** Realtime MIDI: note edits play without a re-bounce. */
import { APPLY_WATCH_MS, remainsFalse } from '../harness.mjs';
export const name = 'realtime-midi';

export async function run(ctx) {
  const { page, fail } = ctx;

  {
    const stepsPending = !(await remainsFalse(
      page,
      () => window.__sonareDebug.applyPending(),
      undefined,
      APPLY_WATCH_MS,
    ));
    if (stepsPending) {
      fail('step bake caused an audio re-bounce (MIDI edits must be realtime)');
    }
    // Mute every strip except the MIDI track that holds the baked pattern, so
    // anything audible at PPQ 0 can only come from that track's realtime MIDI
    // instrument (MIDI clips are never bounced to audio clips anymore).
    await page.click('.dock-tabs button:has-text("Mixer")');
    await page.waitForSelector('.mixer-strips .channel-strip', { timeout: 10000 });
    const muteToggles = page.locator('.mixer-strips .channel-strip .toggle.mute');
    const muteToggleCount = await muteToggles.count();
    for (let i = 1; i < muteToggleCount; i++) await muteToggles.nth(i).click();
    const ids = await page.evaluate(() => window.__sonareDebug.trackIds());
    const patternTrackId = ids[0]; // demo MIDI track, owner of the active clip
    const rulerBox5 = await page.locator('.arrangement-canvas').boundingBox();
    await page.mouse.click(rulerBox5.x + 2, rulerBox5.y + 14);
    await page.click('.transport-bar .transport-key.play');
    await page.waitForFunction(
      (id) => {
        const lane = window.__sonareDebug.trackMeterDb(id);
        const master = window.__sonareDebug.meterPeakDb();
        return lane !== null && lane > -90 && master !== null && master > -90;
      },
      patternTrackId,
      { timeout: 5000 },
    );
    await page.click('.transport-bar .transport-key.stop');
    for (let i = 1; i < muteToggleCount; i++) await muteToggles.nth(i).click();
    console.info('realtime MIDI: baked pattern audible through the engine instruments');
  }
}
