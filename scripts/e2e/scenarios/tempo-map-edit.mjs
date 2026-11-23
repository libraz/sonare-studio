/**
 * Tempo map editing: a second entry added in the Tempo list changes the
 * document tempo map, slows the playhead past it and lengthens the render; one
 * undo restores the constant tempo.
 */
export const name = 'tempo-map-edit';

const PLAYHEAD = 'Playhead position in bars, beats, sixteenths and ticks';
const RANGE = { startPpq: 0, endPpq: 4 };
const SLOW_BPM = 60;

const segments = (page) =>
  page.evaluate(() =>
    window.__sonareDebug
      .projectDocument()
      .tempoSegments.map((segment) => ({ startPpq: segment.startPpq, bpm: segment.bpm })),
  );

const renderSeconds = async (page) => {
  const probe = await page.evaluate(
    (range) => window.__sonareDebug.exportProbe(false, range),
    RANGE,
  );
  return probe.totalFrames / probe.sampleRate;
};

const settle = (page) =>
  page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
    timeout: 20000,
  });

export async function run(ctx) {
  const { page, fail } = ctx;
  const original = await segments(page);
  if (original.length !== 1) {
    fail(`expected a constant tempo to start from: ${JSON.stringify(original)}`);
    return;
  }
  const constantSeconds = await renderSeconds(page);

  // Add an entry at bar 1 beat 3 (ppq 2) that halves the tempo.
  await page.click('.dock-tabs button:has-text("Lists")');
  await page.locator('.list-tab[data-tab-id="tempo"]').click();
  const editor = page.locator('.list-editor').filter({
    has: page.getByLabel('Tempo entry 1 BPM'),
  });
  await editor.getByRole('button', { name: 'Add tempo', exact: true }).click();
  await editor.getByLabel('Tempo entry 2 position (bars.beats)').fill('1.3');
  await editor.getByLabel('Tempo entry 2 BPM').fill(String(SLOW_BPM));
  await editor.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(
    () => window.__sonareDebug.projectDocument().tempoSegments.length === 2,
    null,
    {
      timeout: 5000,
    },
  );
  await settle(page);
  const edited = await segments(page);
  if (Math.abs(edited[1].startPpq - 2) > 0.01 || edited[1].bpm !== SLOW_BPM) {
    fail(`the tempo map did not take the new entry: ${JSON.stringify(edited)}`);
  }

  // Beats 3 and 4 last one second longer at half the tempo.
  const slowedSeconds = await renderSeconds(page);
  const grew = slowedSeconds - constantSeconds;
  if (Math.abs(grew - 1) > 0.15) {
    fail(`render of ppq 0-4 grew by ${grew.toFixed(2)} s, expected about 1 s`);
  }

  // The playhead runs at the new tempo past the entry.
  const field = page.getByLabel(PLAYHEAD);
  await field.focus();
  await field.fill('1.3.1.000');
  await field.press('Enter');
  await page.click('.transport-bar .transport-key.play');
  const start = await page.evaluate(() => window.__sonareDebug.positionPpq());
  await page.waitForTimeout(1500);
  const end = await page.evaluate(() => window.__sonareDebug.positionPpq());
  await page.click('.transport-bar .transport-key.stop');
  const rate = (end - start) / 1.5;
  if (!(rate > 0.6 && rate < 1.4)) {
    fail(`playhead rate past the entry is ${rate.toFixed(2)} PPQ/s, expected about 1`);
  } else {
    console.info(
      `tempo entry added: render +${grew.toFixed(2)} s, playhead ${rate.toFixed(2)} PPQ/s at ${SLOW_BPM} BPM`,
    );
  }

  // One undo restores the constant tempo.
  await page.locator('.undo-toggle').click();
  await page.waitForFunction(
    () => window.__sonareDebug.projectDocument().tempoSegments.length === 1,
    null,
    {
      timeout: 5000,
    },
  );
  await settle(page);
  await page.evaluate(() => window.__sonareDebug.seekPpq(0));
}
