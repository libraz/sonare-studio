/** Piano roll: the grid renders, a note is created and undone. */
export const name = 'piano-roll';

export async function run(ctx) {
  const { page, fail } = ctx;
  const { seededCount } = ctx.state;

  // The note grid renders two stacked canvases; assert nonzero size.
  // The restored workspace may reopen on any editor tab. Select the target
  // explicitly so the canvas visibility assertion describes the actual user
  // journey rather than relying on a default-tab implementation detail.
  await page.click('.dock-tabs button:has-text("Piano Roll")');
  const canvas = page.locator('.note-grid canvas').first();
  await canvas.waitFor({ state: 'visible', timeout: 10000 });
  const box = await canvas.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    fail(`piano roll canvas has no size: ${JSON.stringify(box)}`);
  } else {
    console.info(`canvas size: ${Math.round(box.width)}x${Math.round(box.height)}`);
  }

  // Double-click an empty top-left cell (high pitches, before the phrase) to create a note.
  await page.mouse.dblclick(box.x + box.width * 0.6, box.y + 12);
  await page.waitForFunction(
    (before) => window.__sonareDebug.noteCount() === before + 1,
    seededCount,
    { timeout: 5000 },
  );
  console.info(`note created: ${seededCount} -> ${seededCount + 1}`);

  // Cmd+Z must undo the creation.
  await page.keyboard.press('Meta+z');
  await page.waitForFunction((before) => window.__sonareDebug.noteCount() === before, seededCount, {
    timeout: 5000,
  });
  console.info(`undo restored note count: ${seededCount}`);
}
