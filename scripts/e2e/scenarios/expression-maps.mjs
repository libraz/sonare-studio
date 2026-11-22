/**
 * Expression maps: a preset chosen from the track header menu turns the
 * track's articulation marks into key switches that reach the rendered audio,
 * and removing the map takes them out again.
 */
export const name = 'expression-maps';

const TRACK_NAME = 'Expression map';
const RANGE = { startPpq: 0, endPpq: 4 };

const documentTrack = (page) =>
  page.evaluate((trackName) => {
    const doc = window.__sonareDebug.projectDocument();
    return doc.tracks.find((track) => track.name === trackName) ?? null;
  }, TRACK_NAME);

const render = (page) =>
  page.evaluate((range) => window.__sonareDebug.exportProbe(false, range, true), RANGE);

async function chooseFromHeaderMenu(page, itemId) {
  await page
    .locator('.track-headers .track-header', { hasText: TRACK_NAME })
    .first()
    .click({ button: 'right' });
  await page.locator(`.context-menu-item[data-menu-item-id="${itemId}"]`).click();
}

export async function run(ctx) {
  const { page, fail } = ctx;
  const trackCountBefore = await page.evaluate(() => window.__sonareDebug.trackCount());
  const activeClipBefore = await page.evaluate(() => window.__sonareDebug.activeClipId());

  const trackId = await page.evaluate(() => {
    const { trackId: id } = window.__sonareDebug.addMidiTestClip('Expression map', 0);
    for (const start of [1, 2, 3]) window.__sonareDebug.addNoteAt(67, start, 0.5);
    for (const note of window.__sonareDebug.activeNotes()) {
      window.__sonareDebug.annotateNote(note.id, 'staccato');
    }
    return id;
  });
  await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
    timeout: 20000,
  });
  const baseline = await render(page);
  const baselineStem = baseline.stems?.find((stem) => stem.name === TRACK_NAME);
  if (!baselineStem)
    fail(`the render carried no stem for the track: ${JSON.stringify(baseline.stems)}`);

  await chooseFromHeaderMenu(page, 'expression-map-keySwitchesC1');
  const mapped = await documentTrack(page);
  const entries = mapped?.expressionMap?.entries ?? [];
  if (entries.length === 0 || entries.some((entry) => typeof entry.keySwitch !== 'number')) {
    fail(
      `the key-switch preset was not stored on the track: ${JSON.stringify(mapped?.expressionMap)}`,
    );
  }
  await page.locator('.track-headers .track-header', { hasText: TRACK_NAME }).first().click({
    button: 'right',
  });
  const checked = await page
    .locator('.context-menu-item[data-menu-item-id="expression-map-keySwitchesC1"]')
    .getAttribute('aria-checked');
  if (checked !== 'true') fail('the menu does not show the chosen preset as selected');
  await page.keyboard.press('Escape');

  // Rendered audio carries the key switches the marks asked for.
  await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
    timeout: 20000,
  });
  const withMap = await render(page);
  if (withMap.hash === baseline.hash) {
    fail('the render is identical with and without the expression map: no key switch was sent');
  } else {
    console.info(`key switches reached the render: ${baseline.hash} -> ${withMap.hash}`);
  }

  // Removing the map restores the original render exactly.
  await chooseFromHeaderMenu(page, 'expression-map-off');
  if ((await documentTrack(page))?.expressionMap !== undefined) {
    fail('Off left the expression map on the track');
  }
  const restored = await render(page);
  if (restored.hash !== baseline.hash) {
    fail(`turning the map off did not restore the render: ${restored.hash} vs ${baseline.hash}`);
  }

  await page.evaluate((id) => window.__sonareDebug.removeTrack(id), trackId);
  await page.waitForFunction(
    (count) => window.__sonareDebug.trackCount() === count,
    trackCountBefore,
    { timeout: 5000 },
  );
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), activeClipBefore);
}
