/**
 * Drum kit: the Kit selector of a drum track's GM tab makes the track play the
 * chosen kit, and two kits render the same notes differently.
 */
export const name = 'drum-kit';

const DRUM_CHANNEL = 9;
const NOTES = [36, 38, 42, 38].map((pitch, index) => ({
  pitch,
  startPpq: index * 0.5,
  durationPpq: 0.25,
  channel: DRUM_CHANNEL,
}));

export async function run(ctx) {
  const { page, fail } = ctx;
  const trackCountBefore = await page.evaluate(() => window.__sonareDebug.trackCount());
  const activeClipBefore = await page.evaluate(() => window.__sonareDebug.activeClipId());
  const start = await page.evaluate(() => {
    const clips = window.__sonareDebug.projectDocument().tracks.flatMap((track) => track.clips);
    return (
      Math.ceil(Math.max(0, ...clips.map((clip) => clip.startPpq + clip.lengthPpq)) / 4) * 4 + 4
    );
  });
  const added = await page.evaluate(
    ([clipStart, seed]) => window.__sonareDebug.addNotedMidiClip('Drums kit', clipStart, 4, seed),
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

  if (!(await page.locator('.device-rack').isVisible())) {
    await page.click('.app-bar .devices-toggle');
  }

  /** Chooses the n-th kit that sounds apart from Standard and returns its program number. */
  const useKit = async (which) => {
    await page.locator('.device-rack .instrument-button').click();
    await page.locator('.instrument-picker .picker-tab').filter({ hasText: 'GM' }).click();
    await page.getByRole('combobox', { name: 'Kit', exact: true }).click();
    const options = page.locator('.select-list .select-option:not([aria-disabled="true"])');
    const option = options.nth(which);
    const label = (await option.locator('.select-option-label').textContent()) ?? '';
    await option.click();
    await page.getByRole('button', { name: 'Use GM voice', exact: true }).click();
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });
    return Number(label.split('·')[0]) - 1;
  };
  const kitOf = () =>
    page.evaluate(
      () =>
        window.__sonareDebug.projectDocument().tracks.find((track) => track.name === 'Drums kit')
          ?.instrument ?? null,
    );

  const standard = await useKit(0);
  const standardInstrument = await kitOf();
  const standardRender = await probe();
  const standardAgain = await probe();
  const other = await useKit(1);
  const otherInstrument = await kitOf();
  const otherRender = await probe();
  if (
    standardInstrument?.gmProgram !== standard ||
    otherInstrument?.gmProgram !== other ||
    standard === other
  ) {
    fail(
      `the instrument did not follow the Kit selector: ${JSON.stringify([
        standard,
        standardInstrument,
        other,
        otherInstrument,
      ])}`,
    );
  }
  if (
    standardRender.hash !== standardAgain.hash ||
    standardRender.hash === otherRender.hash ||
    !(standardRender.peakDb > -60) ||
    !(otherRender.peakDb > -60)
  ) {
    fail(
      `two kits did not render differently: kit ${standard} ${standardRender.hash}, ` +
        `kit ${other} ${otherRender.hash}`,
    );
  } else {
    console.info(
      `drum kits ${standard} and ${other} render ${standardRender.hash} vs ${otherRender.hash}`,
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
