/** Score annotations: apply a dynamic from the annotate palette. */
export const name = 'score-annotations';

export async function run(ctx) {
  const { page, fail } = ctx;

  const dynamsBefore = await page.locator('.score-body svg g.dynam').count();
  if (dynamsBefore !== 0) {
    fail(`expected no dynamics glyphs before annotating, got ${dynamsBefore}`);
  }
  // Open annotation from the score's keyboard-accessible object navigator.
  // This avoids relying on an off-screen SVG glyph while exercising the
  // supported ContextMenu route used by screen-reader and keyboard users.
  const scoreNavigator = page.locator('.score-body-wrap [role="listbox"]');
  await scoreNavigator.focus();
  await scoreNavigator.press('ContextMenu');
  await page.waitForSelector('.annotation-palette', { timeout: 5000 });
  await page
    .locator('.annotation-palette .palette-dynamics')
    .filter({ hasText: /^f$/ })
    .first()
    .click();
  // The annotation command re-transcribes (debounced) and the engraved SVG
  // must come back containing a dynamics glyph. MIDI itself never changes.
  await page.waitForFunction(
    () => document.querySelectorAll('.score-body svg g.dynam').length > 0,
    null,
    { timeout: 60000 },
  );
  console.info('score annotation engraved: dynamics glyph rendered in the SVG');
  await page.click('.annotation-palette button[aria-label="Close annotation palette"]');
  await page.click('.score-toolbar button:has-text("Annotate")');
  await page.waitForSelector('.annotation-palette', { state: 'detached', timeout: 5000 });
  console.info('annotate mode toggled off, palette closed');
}
