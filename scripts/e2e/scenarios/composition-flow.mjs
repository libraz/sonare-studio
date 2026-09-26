/** Compose a song from an empty project: chords, parts, then a lead clip. */
export const name = 'composition-flow';

export async function run({ page, baseUrl, fail }) {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="start-new"]', { timeout: 30000 });
  await page.click('[data-testid="start-new"]');
  await page.click('#new-project-template-empty');
  await page
    .locator('.modal-card:has(#new-project-template-empty) .modal-foot button.primary')
    .click();
  await page.locator('.modal-scrim.is-launcher-layer').waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.__sonareDebug?.initialized() === true);
  if (await page.locator('.tour-tooltip').isVisible()) {
    await page.click('.tour-tooltip .tour-skip');
    await page.locator('.tour-overlay').waitFor({ state: 'detached' });
  }

  await page.click('#menubar-trigger-generate');
  await page.click('[id="menubar-generate-generate.tracks"]');
  await page.locator('.gate-create').click();
  await page.locator('.generate-confirm').click();
  await page.locator('.continue-tracks').click();
  await page.locator('.part-list').waitFor();

  const chordSummary = (await page.locator('.chord-summary-bars').textContent())?.trim();
  if (chordSummary !== '4 bars' && chordSummary !== '4小節') {
    fail(`unexpected generated progression length: ${chordSummary}`);
  }

  await page
    .locator('.preset-chip')
    .filter({ hasText: /^(All|すべて)$/ })
    .click();
  const selected = await page.locator('.part-check input:checked').count();
  if (selected !== 4) fail(`expected four available parts before a lead exists, got ${selected}`);
  console.info(`all preset selected ${selected} available parts`);
  const before = await page.evaluate(() => window.__sonareDebug.trackCount());
  await page.locator('.generate-confirm').click();
  await page.waitForFunction((count) => window.__sonareDebug.trackCount() > count, before, {
    timeout: 5000,
  });
  const after = await page.evaluate(() => window.__sonareDebug.trackCount());
  if (after - before !== selected) {
    fail(`selected ${selected} parts but generated ${after - before} tracks`);
  }
  console.info(`generated ${after - before} part tracks`);

  await page.locator('.track-done').waitFor();
  await page.locator('.compose-lead').click();
  await page.locator('.modal-card:has(.track-done)').waitFor({ state: 'detached' });
  const lead = await page.evaluate(() => {
    const debug = window.__sonareDebug;
    const clip = debug.clipRanges().find((entry) => entry.id === debug.activeClipId());
    return { clip, activeTrackId: debug.activeTrackId(), trackCount: debug.trackCount() };
  });
  if (!lead.clip || lead.clip.trackId !== lead.activeTrackId || lead.clip.lengthPpq !== 16) {
    fail(`lead editor did not open on a four-bar clip: ${JSON.stringify(lead)}`);
  }
  if (lead.trackCount !== after + 1) fail('compose lead did not add one MIDI track');

  // A fresh project can inherit the prior workspace's scroll and tool. Set
  // the editor up as a returning user would before drawing the melody.
  await page.locator('.tool-palette .tool-button').nth(1).click();
  await page.locator('.zoom-cluster .fit-pair .fit-btn').first().click();
  const canvas = page.locator('.note-grid canvas').first();
  await canvas.waitFor({ state: 'visible' });
  const box = await canvas.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error('lead piano roll has no size');
  const notesBefore = await page.evaluate(() => window.__sonareDebug.noteCount());
  for (const [index, fraction] of [0.15, 0.22, 0.3].entries()) {
    const currentBox = await canvas.boundingBox();
    if (!currentBox) throw new Error('lead piano roll disappeared while drawing');
    const beforeClick = await page.evaluate(() => window.__sonareDebug.noteCount());
    const x = currentBox.x + currentBox.width * fraction;
    const y = currentBox.y + 12 + index * 14;
    await page.mouse.move(x, y);
    await page.locator('.cell-status').textContent();
    await page.waitForTimeout(60);
    await page.mouse.click(x, y);
    try {
      await page.waitForFunction((n) => window.__sonareDebug.noteCount() === n + 1, beforeClick, {
        timeout: 15000,
      });
    } catch (error) {
      const actual = await page.evaluate(() => window.__sonareDebug.noteCount());
      const status = (await page.locator('.cell-status').textContent())?.trim();
      const tool = await page
        .locator('.tool-palette .tool-button[aria-pressed="true"]')
        .getAttribute('aria-label');
      throw new Error(
        `lead note ${index} did not land: count ${actual}, status ${status}, tool ${tool}; ${error}`,
      );
    }
    const activeClipId = await page.evaluate(() => window.__sonareDebug.activeClipId());
    if (activeClipId !== lead.clip.id) throw new Error(`lead clip lost focus: ${activeClipId}`);
  }
  console.info(`lead notes placed: ${notesBefore} -> ${notesBefore + 3}`);

  // The previously unavailable counter melody becomes possible once the
  // selected lead clip contains notes.
  await page.click('#menubar-trigger-generate');
  await page.click('[id="menubar-generate-generate.tracks"]');
  await page.locator('.part-list').waitFor();
  const counterBox = page.locator('.part-row').nth(3).locator('.part-check input');
  if (await counterBox.isDisabled()) fail('counter melody stayed disabled after lead notes');
  await counterBox.check();
  const counterAction = (await page.locator('.generate-confirm').textContent())?.trim();
  if (counterAction !== 'Generate 1 track' && counterAction !== '1トラックを生成') {
    fail(`single-part action has an unexpected label: ${counterAction}`);
  }
  const counterBefore = await page.evaluate(() => window.__sonareDebug.trackCount());
  await page.locator('.generate-confirm').click();
  await page.waitForFunction(
    (count) => window.__sonareDebug.trackCount() === count + 1,
    counterBefore,
    { timeout: 5000 },
  );
  console.info('counter melody generated from the lead clip');
  if (browserErrors.length > 0) fail(`browser errors: ${browserErrors.join(' | ')}`);
}
