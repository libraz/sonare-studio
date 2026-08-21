/** Realtime MIDI: note edits play without a re-bounce. */
export const name = 'realtime-midi';

export async function run(ctx) {
  const { page, fail } = ctx;

  {
    await page.waitForTimeout(400);
    const stepsPending = await page.evaluate(() => window.__sonareDebug.applyPending());
    if (stepsPending) {
      fail('step bake caused an audio re-bounce (MIDI edits must be realtime)');
    }
    // Mute the audio track: anything audible at PPQ 0 must then come from the
    // engine's realtime MIDI instruments (MIDI clips are never bounced to
    // audio clips anymore).
    await page.click('.dock-tabs button:has-text("Mixer")');
    await page.waitForSelector('.mixer-strips .channel-strip', { timeout: 10000 });
    const audioMute = page.locator('.mixer-strips .channel-strip .toggle.mute').nth(2);
    await audioMute.click();
    const rulerBox5 = await page.locator('.arrangement-canvas').boundingBox();
    await page.mouse.click(rulerBox5.x + 2, rulerBox5.y + 14);
    await page.click('.transport-bar .transport-key.play');
    await page.waitForFunction(
      () => {
        const peak = window.__sonareDebug.meterPeakDb();
        return peak !== null && peak > -90;
      },
      null,
      { timeout: 5000 },
    );
    await page.click('.transport-bar .transport-key.stop');
    await audioMute.click();
    console.info('realtime MIDI: baked pattern audible through the engine instruments');
  }
}
