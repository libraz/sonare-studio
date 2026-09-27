import * as boot from './boot.mjs';

/** Reach a glossary button by moving across a crowded existing song. */
export const name = 'theory-hover';

export async function run(ctx) {
  const { page, fail } = ctx;
  if (!(await page.evaluate(() => window.__sonareDebug?.initialized() === true))) {
    await boot.run(ctx);
  }
  await page.click('.dock-tabs button:has-text("Piano Roll")');
  const grid = page.locator('.note-grid');
  const box = await grid.boundingBox();
  if (!box) throw new Error('existing song piano roll is not visible');

  const card = page.locator('.note-grid-theory-card');
  // Workspace layout and vertical zoom persist between sessions. Find an
  // explanatory note in the visible part of the bundled song instead of
  // assuming a particular row stays at one pixel coordinate.
  let start = null;
  for (const localX of [605, 450, 750, 300, 900]) {
    if (localX >= box.width - 10) continue;
    for (let localY = 10; localY < box.height - 10; localY += 5) {
      await page.mouse.move(box.x + localX, box.y + localY);
      await page.waitForTimeout(12);
      if (await card.locator('.theory-card-info').first().isVisible()) {
        start = { x: box.x + localX, y: box.y + localY };
        break;
      }
    }
    if (start) break;
  }
  if (!start) throw new Error('no visible existing note offered a theory glossary');
  await card.waitFor({ state: 'visible' });
  const title = await card.locator('.theory-card-title').textContent();
  const info = card.locator('.theory-card-info').first();
  const infoBox = await info.boundingBox();
  if (!title || !infoBox) throw new Error('existing song note has no glossary button');
  const target = { x: infoBox.x + infoBox.width / 2, y: infoBox.y + infoBox.height / 2 };

  for (let step = 1; step <= 40; step++) {
    await page.mouse.move(
      start.x + ((target.x - start.x) * step) / 40,
      start.y + ((target.y - start.y) * step) / 40,
    );
    await page.waitForTimeout(20);
    const current = await page.evaluate(
      () =>
        document.querySelector('.note-grid-theory-card .theory-card-title')?.textContent ?? null,
    );
    if (current !== title) {
      fail(
        `theory card changed while reaching its glossary: ${title} -> ${current} at step ${step}`,
      );
      return;
    }
  }
  await page.mouse.click(target.x, target.y);
  await card.locator('.theory-card-glossary').waitFor({ state: 'visible' });
  console.info(`existing song glossary opened from ${title}`);
}
