import { pointForNote } from './imported-song-edit.mjs';

/** Reharmonize a note already in the song and inspect its live theory warning. */
export const name = 'secondary-dominant-guidance';

async function cardLines(page, label) {
  return page.evaluate(
    (wanted) =>
      [...document.querySelectorAll('.note-grid-theory-card .theory-card-line')]
        .filter((line) => line.querySelector('.theory-card-label')?.textContent?.trim() === wanted)
        .map((line) => line.querySelector('.theory-card-text')?.textContent?.trim() ?? ''),
    label,
  );
}

async function warningPixels(page, point) {
  return page.evaluate(({ x, y }) => {
    const grid = document.querySelector('.note-grid');
    const canvas = grid?.querySelectorAll('canvas')[1];
    const rect = grid?.getBoundingClientRect();
    const ctx = canvas?.getContext('2d');
    if (!canvas || !rect || !ctx) throw new Error('note canvas missing');
    const dpr = canvas.width / canvas.clientWidth;
    const top = Math.max(0, Math.round((y - rect.top - 8) * dpr));
    const height = Math.min(canvas.height - top, Math.round(18 * dpr));
    const pixels = ctx.getImageData(0, top, canvas.width, height).data;
    let red = 0;
    let amber = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const [r, g, b] = pixels.subarray(index, index + 3);
      if (r > 220 && g < 120 && b < 120) red++;
      if (r > 220 && g > 120 && g < 210 && b < 80) amber++;
    }
    const localX = Math.round((x - rect.left) * dpr);
    const localY = Math.round((y - rect.top) * dpr);
    const sample = [...ctx.getImageData(localX, localY, 1, 1).data];
    return {
      red,
      amber,
      sample,
      canvasSize: [canvas.width, canvas.height],
      local: [localX, localY],
    };
  }, point);
}

async function visibleNotePoint(page, id) {
  return page.evaluate((noteId) => {
    const grid = document.querySelector('.note-grid');
    const props = grid?.__vueParentComponent?.props;
    const note = props?.notes?.find((entry) => entry.id === noteId);
    if (!grid || !props?.range || !note) throw new Error(`visible note ${noteId} missing`);
    const rect = grid.getBoundingClientRect();
    return {
      x: rect.left + props.range.ppqToX(note.startPpq) + 5,
      y: rect.top + props.range.pitchToY(note.pitch) + 3,
    };
  }, id);
}

export async function run({ page, fail }) {
  await page
    .locator('.legend-chip')
    .filter({ hasText: /^Lead$/ })
    .click();
  await page.locator('.roll-toolbar .tb-segmented[role="group"] .tb-seg').first().click();
  await page.locator('.roll-toolbar .tb-segmented[role="group"] .tb-seg').nth(1).click();
  const view = page.locator('.roll-toolbar .tb-menu').filter({ hasText: /^\s*View\s*$/ });
  await view.click();
  await page.getByRole('combobox', { name: 'Ghost note overlay scope' }).click();
  await page.getByRole('option', { name: 'No ghosts' }).click();
  await view.click();
  await page.locator('.view-popover').waitFor({ state: 'hidden' });
  await page.locator('.tool-palette .tool-button').first().click();
  const originalCount = await page.evaluate(() => window.__sonareDebug.activeNotes().length);
  const oldNotePoint = await pointForNote(page, 64, 6.3);
  await page.mouse.click(oldNotePoint.x, oldNotePoint.y);
  await page.keyboard.press('Delete');
  await page.waitForFunction(
    (count) => window.__sonareDebug.activeNotes().length === count - 1,
    originalCount,
  );
  await page.locator('.tool-palette .tool-button').nth(1).click();
  const beforeNotes = await page.evaluate(() => window.__sonareDebug.activeNotes());
  const notePoint = await pointForNote(page, 65, 5.5);
  const noteEnd = await pointForNote(page, 65, 6.75);
  await page.mouse.move(notePoint.x, notePoint.y);
  await page.mouse.down();
  await page.mouse.move(noteEnd.x, noteEnd.y, { steps: 8 });
  await page.mouse.up();
  try {
    await page.waitForFunction(
      (count) => window.__sonareDebug.activeNotes().length === count + 1,
      beforeNotes.length,
      { timeout: 3000 },
    );
  } catch {
    throw new Error(
      `secondary note did not land: ${JSON.stringify(
        await page.evaluate(() => ({
          notes: window.__sonareDebug.activeNotes(),
          active: window.__sonareDebug.activeClipId(),
          status: document.querySelector('.cell-status')?.textContent,
          tool: document
            .querySelector('.tool-palette .tool-button[aria-pressed="true"]')
            ?.getAttribute('aria-label'),
        })),
      )}`,
    );
  }
  const existing = (await page.evaluate(() => window.__sonareDebug.activeNotes())).find(
    (note) => !beforeNotes.some((before) => before.id === note.id),
  );
  if (
    existing?.pitch !== 65 ||
    existing.startPpq >= 6 ||
    existing.startPpq + existing.durationPpq <= 6
  ) {
    fail(`harmonic test note did not cross the new chord boundary: ${JSON.stringify(existing)}`);
  }
  const beforePoint = await visibleNotePoint(page, existing.id);
  await page.mouse.move(0, 0);
  await page.mouse.move(beforePoint.x, beforePoint.y);
  await page.locator('.note-grid-theory-card').waitFor({ state: 'visible' });
  const beforeSafety = await cardLines(page, 'Safety');
  const beforePixels = await warningPixels(page, beforePoint);
  console.info(
    `existing F4 before secondary dominant: ${beforeSafety}, stripe ${JSON.stringify(beforePixels)}`,
  );

  await page.mouse.move(0, 0);
  await page.click('.dock-tabs button:has-text("Lists")');
  await page.locator('.list-tab[data-tab-id="chords"]').click();
  const gRow = page.locator('.chord-row:has(.cell-name:text-is("G"))').first();
  await gRow.locator('.cell-actions .row-button').first().click();
  const names = await page.locator('.chord-row .cell-name').allTextContents();
  if (names.join(',') !== 'C,F,D7,G,C')
    fail(`secondary dominant did not split the F bar: ${names.join(',')}`);
  const appliedRow = page.locator('.chord-row:has(.cell-name:text-is("D7"))').first();
  const numeral = (await appliedRow.locator('.cell-roman').textContent())?.trim();
  if (numeral !== 'V7/V') fail(`secondary dominant is misnamed in chord list: ${numeral}`);

  await page.click('.dock-tabs button:has-text("Piano Roll")');
  const changedPoint = await visibleNotePoint(page, existing.id);
  await page.mouse.move(changedPoint.x, changedPoint.y);
  await page.locator('.note-grid-theory-card').waitFor({ state: 'visible' });
  // Canvas redraw is queued separately from the Vue card update.
  await page.waitForTimeout(120);
  const afterSafety = await cardLines(page, 'Safety');
  const afterPixels = await warningPixels(page, changedPoint);
  console.info(`existing F4 after D7: ${afterSafety}, stripe ${JSON.stringify(afterPixels)}`);
  if (
    afterSafety.join('|') === beforeSafety.join('|') ||
    !afterSafety.some((line) => line.includes('chord change')) ||
    afterPixels.amber <= beforePixels.amber
  ) {
    fail(
      `existing note gained no theory warning after chord edit: ${afterSafety}, ${JSON.stringify(afterPixels)}`,
    );
  }
  // The pointer does not move across the Undo. Both the note stripe and the
  // already-open theory card must react to the restored harmony.
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(() => window.__sonareDebug.chordCount() === 4);
  await page.waitForTimeout(100);
  const undoneSafety = await cardLines(page, 'Safety');
  const undonePixels = await warningPixels(page, changedPoint);
  if (
    undoneSafety.join('|') !== beforeSafety.join('|') ||
    undonePixels.amber > beforePixels.amber
  ) {
    fail(
      `Undo left stale theory on the existing note: ${undoneSafety}, ${JSON.stringify(undonePixels)}`,
    );
  }
  console.info(`Undo refreshed visible theory card and note stripe: ${undoneSafety}`);
}
