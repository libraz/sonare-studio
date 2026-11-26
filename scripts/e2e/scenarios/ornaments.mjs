/** Ornaments: the Decorate panel marks notes with a technique and moves none of them. */
export const name = 'ornaments';

const ONSETS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5];

const geometry = (page) =>
  page.evaluate(() =>
    window.__sonareDebug.activeNotes().map((note) => [note.id, note.startPpq, note.durationPpq]),
  );

export async function run(ctx) {
  const { page, fail } = ctx;
  const trackCountBefore = await page.evaluate(() => window.__sonareDebug.trackCount());
  const activeClipBefore = await page.evaluate(() => window.__sonareDebug.activeClipId());

  const added = await page.evaluate((onsets) => {
    const { trackId } = window.__sonareDebug.addMidiTestClip('Ornament pass', 0);
    for (const start of onsets) window.__sonareDebug.addNoteAt(62, start, 0.5);
    return trackId;
  }, ONSETS);
  const geometryBefore = await geometry(page);
  if (Object.keys(await page.evaluate(() => window.__sonareDebug.noteArticulations())).length > 0) {
    fail('the fresh clip already carries articulation marks');
  }

  await page.click('.dock-tabs button:has-text("Piano Roll")');
  await page
    .locator('.roll-toolbar .tb-menu')
    .filter({ hasText: /^\s*Decorate\s*$/ })
    .click();
  const panel = page.locator('.ornament-panel');
  await panel.waitFor({ state: 'visible', timeout: 5000 });

  // Every technique plans its own count; pick the one that has the most to mark.
  await panel.locator('input[type="range"]').fill('1');
  let chosen = null;
  for (const label of ['Ghost', 'Flam', 'Drag', 'Slide', 'Accent']) {
    await panel.locator('.orn-segment', { hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
    const text = ((await panel.locator('.orn-preview').textContent()) ?? '').trim();
    const planned = text.match(/^Marks (\d+) of (\d+) notes$/);
    if (planned && Number(planned[1]) > 0 && (!chosen || Number(planned[1]) > chosen.count)) {
      chosen = { label, count: Number(planned[1]), total: Number(planned[2]) };
    }
  }
  if (!chosen) {
    fail('no technique offered any note to mark in the Decorate preview');
    return;
  }
  await panel.locator('.orn-segment', { hasText: new RegExp(`^\\s*${chosen.label}\\s*$`) }).click();
  console.info(`decorate preview: ${chosen.label} marks ${chosen.count} of ${chosen.total}`);
  await panel.getByRole('button', { name: 'Apply' }).click();
  await panel.waitFor({ state: 'detached', timeout: 5000 });

  const articulations = await page.evaluate(() => window.__sonareDebug.noteArticulations());
  const values = Object.values(articulations);
  if (
    values.length !== chosen.count ||
    values.some((value) => value !== chosen.label.toLowerCase())
  ) {
    fail(
      `Apply wrote ${JSON.stringify(articulations)}, the preview promised ` +
        `${chosen.count} ${chosen.label.toLowerCase()} marks`,
    );
  }
  if (JSON.stringify(await geometry(page)) !== JSON.stringify(geometryBefore)) {
    fail('decorating moved or resized notes; it must only add marks');
  }
  console.info(`ornaments applied: ${values.length} ${chosen.label.toLowerCase()} marks`);

  // One undo takes every mark back.
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForFunction(
    () => Object.keys(window.__sonareDebug.noteArticulations()).length === 0,
    null,
    { timeout: 5000 },
  );

  await page.evaluate((id) => window.__sonareDebug.removeTrack(id), added);
  await page.waitForFunction(
    (count) => window.__sonareDebug.trackCount() === count,
    trackCountBefore,
    { timeout: 5000 },
  );
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), activeClipBefore);
}
