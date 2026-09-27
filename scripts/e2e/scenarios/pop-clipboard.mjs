/** Copy a bar-aligned clip via Edit and paste it into an empty arrangement lane. */
export const name = 'pop-clipboard';

export async function run({ page, fail }) {
  const song = await page.evaluate(() => ({
    tracks: window.__sonareDebug.trackIds(),
    clips: window.__sonareDebug.clipRanges(),
  }));
  const leadTrackId = song.tracks[4];
  const source = song.clips.find((clip) => clip.trackId === leadTrackId && clip.startPpq === 0);
  if (!source) throw new Error('generated lead clip missing before clipboard edit');
  await page.locator('.tool-palette .tool-button').first().click();
  const box = await page.locator('.arrangement-canvas canvas').first().boundingBox();
  if (!box) throw new Error('arrangement canvas missing');
  const header = page
    .locator('.track-header')
    .filter({ has: page.locator('.track-name:text-is("Lead")') })
    .first();
  const headerBox = await header.boundingBox();
  if (!headerBox) throw new Error('generated lead track header missing');
  const laneY = headerBox.y + Math.min(headerBox.height, 56) / 2;
  await page.mouse.click(box.x + 20, laneY);
  const focused = await page.evaluate(() => window.__sonareDebug.activeClipId());
  if (focused !== source.id) {
    fail('arrangement click did not focus the generated lead clip');
  }

  await page.click('#menubar-trigger-edit');
  const copy = page.locator('[id="menubar-edit-edit.copy"]');
  if ((await copy.getAttribute('aria-disabled')) === 'true')
    fail('Edit Copy is disabled for a selected arrangement clip');
  await copy.click();

  await page.mouse.click(box.x + 320.3, laneY, { button: 'right' });
  const paste = page.locator('.context-menu-item[data-menu-item-id="paste"]');
  await paste.waitFor({ state: 'visible' });
  await paste.click();
  await page.waitForFunction(
    ({ trackId, count }) =>
      window.__sonareDebug.clipRanges().filter((clip) => clip.trackId === trackId).length ===
      count + 1,
    {
      trackId: leadTrackId,
      count: song.clips.filter((clip) => clip.trackId === leadTrackId).length,
    },
  );
  const pasted = (await page.evaluate(() => window.__sonareDebug.clipRanges())).find(
    (clip) => clip.trackId === leadTrackId && clip.startPpq === 32,
  );
  if (!pasted || pasted.lengthPpq !== source.lengthPpq) {
    fail(`empty-lane Paste missed the bar boundary: ${JSON.stringify(pasted)}`);
    return;
  }

  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+Shift+f');
  const sourceX = await page.evaluate(
    (beat) => {
      const canvas = document.querySelector('.arrangement-canvas');
      const range = canvas?.__vueParentComponent?.props.range;
      if (!canvas || !range) throw new Error('arrangement range missing');
      const rect = canvas.getBoundingClientRect();
      const localX = range.ppqToX(beat);
      if (localX < 0 || localX > rect.width)
        throw new Error('original lead clip is outside the fitted arrangement');
      return rect.left + localX;
    },
    source.startPpq + source.lengthPpq / 2,
  );
  await page.mouse.click(sourceX, laneY);
  const selectedSource = await page.evaluate(() => window.__sonareDebug.activeClipId());
  if (selectedSource !== source.id)
    fail(`arrangement selected clip ${selectedSource} instead of ${source.id} before Cut`);
  await page.click('#menubar-trigger-edit');
  const cut = page.locator('[id="menubar-edit-edit.cut"]');
  if ((await cut.getAttribute('aria-disabled')) === 'true')
    fail('Edit Cut is disabled for an arrangement clip');
  await cut.click();
  await page.waitForFunction(
    (id) => !window.__sonareDebug.clipRanges().some((clip) => clip.id === id),
    source.id,
  );
  if ((await page.evaluate(() => window.__sonareDebug.positionPpq())) !== 0) {
    fail('clipboard Paste test is no longer at bar one');
  }
  await page.click('#menubar-trigger-edit');
  const editPaste = page.locator('[id="menubar-edit-edit.paste"]');
  if ((await editPaste.getAttribute('aria-disabled')) === 'true') {
    fail('Edit Paste is disabled after cutting the active clip');
  } else {
    await editPaste.click();
    await page.waitForFunction(
      (trackId) =>
        window.__sonareDebug
          .clipRanges()
          .some((clip) => clip.trackId === trackId && clip.startPpq === 0),
      leadTrackId,
    );
  }
  console.info('Edit Copy/Cut/Paste and empty-lane bar snap preserved the lead clip');
}
