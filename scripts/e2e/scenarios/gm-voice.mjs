/**
 * GM voice: choosing a built-in GM program in the instrument picker's GM tab
 * makes the track play that program and changes the rendered notes.
 */
export const name = 'gm-voice';

const GM_PROGRAM = 24;
const NOTES = [60, 64, 67].map((pitch, index) => ({
  pitch,
  startPpq: index * 0.5,
  durationPpq: 0.5,
}));

const trackInstrument = (page, trackName) =>
  page.evaluate(
    (target) =>
      window.__sonareDebug.projectDocument().tracks.find((track) => track.name === target)
        ?.instrument ?? null,
    trackName,
  );

export async function run(ctx) {
  const { page, fail } = ctx;
  const trackCountBefore = await page.evaluate(() => window.__sonareDebug.trackCount());
  const activeClipBefore = await page.evaluate(() => window.__sonareDebug.activeClipId());
  // Past every other clip, so the probe window holds only this track.
  const start = await page.evaluate(() => {
    const clips = window.__sonareDebug.projectDocument().tracks.flatMap((track) => track.clips);
    return (
      Math.ceil(Math.max(0, ...clips.map((clip) => clip.startPpq + clip.lengthPpq)) / 4) * 4 + 4
    );
  });
  const added = await page.evaluate(
    ([clipStart, seed]) => window.__sonareDebug.addNotedMidiClip('GM voice', clipStart, 4, seed),
    [start, NOTES],
  );
  await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
    timeout: 20000,
  });
  const probe = () =>
    page.evaluate((range) => window.__sonareDebug.exportProbe(false, range), {
      startPpq: start,
      endPpq: start + 2,
    });
  const first = await probe();
  const again = await probe();
  if (first.hash !== again.hash || !(first.peakDb > -60)) {
    fail(`the baseline render is not stable audio: ${JSON.stringify([first, again])}`);
  }

  // Pick the program in the GM tab and use it.
  if (!(await page.locator('.device-rack').isVisible())) {
    await page.click('.app-bar .devices-toggle');
  }
  await page.locator('.device-rack .instrument-button').click();
  await page.locator('.instrument-picker .picker-tab').filter({ hasText: 'GM' }).click();
  await page.getByRole('combobox', { name: 'Program', exact: true }).click();
  await page
    .getByRole('option', { name: new RegExp(`^${String(GM_PROGRAM + 1).padStart(3, '0')} · `) })
    .click();
  await page.getByRole('button', { name: 'Use GM voice', exact: true }).click();
  await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
    timeout: 20000,
  });
  const instrument = await trackInstrument(page, 'GM voice');
  if (instrument?.useGmPrograms !== true || instrument.gmProgram !== GM_PROGRAM) {
    fail(`the track instrument is not GM program ${GM_PROGRAM}: ${JSON.stringify(instrument)}`);
  }
  const voiced = await probe();
  if (voiced.hash === first.hash || !(voiced.peakDb > -60)) {
    fail(`the GM voice did not change the render: ${first.hash} -> ${voiced.hash}`);
  } else {
    console.info(
      `GM program ${GM_PROGRAM}: render ${first.hash} (${first.peakDb.toFixed(1)} dB) -> ` +
        `${voiced.hash} (${voiced.peakDb.toFixed(1)} dB)`,
    );
  }

  await page.evaluate((id) => window.__sonareDebug.removeTrack(id), added.trackId);
  await page.waitForFunction(
    (count) => window.__sonareDebug.trackCount() === count,
    trackCountBefore,
    { timeout: 5000 },
  );
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), activeClipBefore);
}
