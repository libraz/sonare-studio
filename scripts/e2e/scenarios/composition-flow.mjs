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

  const quickParts = await page
    .locator('.part-row')
    .evaluateAll((rows) =>
      rows
        .map((row, index) => (row.querySelector('.part-check input')?.checked ? index : -1))
        .filter((index) => index >= 0),
    );
  if (quickParts.join(',') !== '1,2,4') {
    fail(`new composer did not start with drums, bass and backing: ${quickParts.join(',')}`);
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
  for (const [index, ppq] of [1, 6, 11].entries()) {
    const currentBox = await canvas.boundingBox();
    if (!currentBox) throw new Error('lead piano roll disappeared while drawing');
    const beforeClick = await page.evaluate(() => window.__sonareDebug.noteCount());
    const localX = await page.evaluate((beat) => {
      const grid = document.querySelector('.note-grid');
      const range = grid?.__vueParentComponent?.props.range;
      if (!range) throw new Error('lead piano-roll range missing');
      return range.ppqToX(beat);
    }, ppq);
    const x = currentBox.x + localX;
    const y = currentBox.y + currentBox.height * (0.35 + index * 0.12);
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
        `lead note ${index} did not land: count ${actual}, status ${status}, tool ${tool}, browser errors ${browserErrors.join(' | ')}; ${error}`,
      );
    }
    const activeClipId = await page.evaluate(() => window.__sonareDebug.activeClipId());
    if (activeClipId !== lead.clip.id) throw new Error(`lead clip lost focus: ${activeClipId}`);
  }
  console.info(`lead notes placed: ${notesBefore} -> ${notesBefore + 3}`);

  // Accompaniment ghosts are useful pitch references while drawing a lead;
  // the pencil must write through them instead of switching tracks.
  const ghostPoint = await page.evaluate(() => {
    const grid = document.querySelector('.note-grid');
    const props = grid?.__vueParentComponent?.props;
    if (!grid || !props?.range) return null;
    const rect = grid.getBoundingClientRect();
    const { range } = props;
    for (const ghost of props.ghostNotes ?? []) {
      const beat = ghost.startPpq + Math.min(0.1, ghost.durationPpq / 2);
      const x = range.ppqToX(beat);
      const y = range.pitchToY(ghost.pitch) + range.rowHeight / 2;
      if (x < 20 || x > rect.width - 20 || y < 40 || y > rect.height - 20) continue;
      if (
        props.notes.some(
          (note) =>
            note.pitch === ghost.pitch &&
            note.startPpq <= beat &&
            beat < note.startPpq + note.durationPpq,
        )
      )
        continue;
      return { x: rect.left + x, y: rect.top + y };
    }
    return null;
  });
  if (!ghostPoint) fail('no visible accompaniment ghost for lead-pencil safety check');
  else {
    const beforeGhostDraw = await page.evaluate(() => window.__sonareDebug.noteCount());
    await page.mouse.click(ghostPoint.x, ghostPoint.y);
    await page.waitForFunction(
      (count) => window.__sonareDebug.noteCount() === count + 1,
      beforeGhostDraw,
    );
    if ((await page.evaluate(() => window.__sonareDebug.activeClipId())) !== lead.clip.id) {
      fail('drawing over an accompaniment ghost switched away from the lead clip');
    }
    console.info('lead pencil drew through an accompaniment ghost without changing parts');
  }

  // The previously unavailable counter melody becomes possible once the
  // selected lead clip contains notes.
  await page.click('#menubar-trigger-generate');
  await page.click('[id="menubar-generate-generate.tracks"]');
  await page.locator('.part-list').waitFor();
  const counterBox = page.locator('.part-row').nth(3).locator('.part-check input');
  if (await counterBox.isDisabled()) fail('counter melody stayed disabled after lead notes');
  // The normal dialog now starts with accompaniment selected. Switch to only
  // the counter melody when testing a one-part regeneration.
  while ((await page.locator('.part-check input:checked').count()) > 0) {
    await page.locator('.part-check input:checked').first().uncheck();
  }
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
