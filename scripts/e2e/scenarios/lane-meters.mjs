/** Per-lane meters: each track meter follows its own engine lane. */
export const name = 'lane-meters';

export async function run(ctx) {
  const { page, fail } = ctx;

  {
    const ids = await page.evaluate(() => window.__sonareDebug.trackIds());
    const midiTrackId = ids[0]; // demo MIDI track
    const audioTrackId = ids[2]; // imported-audio track (clip at PPQ 0)
    const rulerBox6 = await page.locator('.arrangement-canvas').boundingBox();
    await page.mouse.click(rulerBox6.x + 2, rulerBox6.y + 14);
    await page.click('.transport-bar .transport-key.play');
    await page.waitForFunction(
      ([midiId, audioId]) => {
        const a = window.__sonareDebug.trackMeterDb(midiId);
        const b = window.__sonareDebug.trackMeterDb(audioId);
        return a !== null && a > -90 && b !== null && b > -90;
      },
      [midiTrackId, audioTrackId],
      { timeout: 5000 },
    );
    const lufs = await page.evaluate(() => window.__sonareDebug.masterLufs());
    if (lufs === null || !(lufs > -70)) {
      fail(`master meter lost its loudness record: momentary LUFS ${lufs}`);
    }
    // Muting one lane must silence only that lane's meter.
    const midiMute = page.locator('.mixer-strips .channel-strip .toggle.mute').nth(0);
    await midiMute.click();
    await page.waitForFunction(
      ([midiId, audioId]) => {
        const a = window.__sonareDebug.trackMeterDb(midiId);
        const b = window.__sonareDebug.trackMeterDb(audioId);
        return a !== null && a <= -90 && b !== null && b > -90;
      },
      [midiTrackId, audioTrackId],
      { timeout: 5000 },
    );
    await page.click('.transport-bar .transport-key.stop');
    await midiMute.click();
    console.info(`per-lane meters independent (master momentary LUFS ${lufs.toFixed(1)})`);
  }
}
