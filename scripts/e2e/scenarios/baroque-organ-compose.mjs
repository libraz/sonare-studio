/** Compose four organ voices from a 64-bar D-minor template. */
export const name = 'baroque-organ-compose';

function trackOf(document, name) {
  const track = document.tracks.find((entry) => entry.name === name);
  if (!track) throw new Error(`missing organ voice ${name}`);
  return track;
}

async function openTracks(page) {
  await page.locator('#menubar-trigger-generate').click();
  await page.locator('[id="menubar-generate-generate.tracks"]').click();
  await page.locator('.part-list').waitFor({ state: 'visible' });
}

async function closeGeneration(page) {
  await page.locator('.track-done').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('.modal-card:has(.track-done) .modal-foot button:not(.primary)').click();
  await page.locator('.modal-card:has(.track-done)').waitFor({ state: 'detached' });
}

async function chooseSinglePart(page, index, trackId) {
  const rows = page.locator('.part-row');
  for (let part = 0; part < 5; part += 1) {
    const check = rows.nth(part).locator('.part-check input');
    if (part === index) await check.check();
    else if (await check.isChecked()) await check.uncheck();
  }
  await rows.nth(index).locator('.part-target').selectOption(`replace:${trackId}`);
}

export async function run({ page, baseUrl, fail }) {
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on('pageerror', onError);
  try {
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.locator('[data-testid="start-new"]').click();
    await page.locator('#new-project-template-baroque-organ').click();
    await page
      .locator('.modal-card:has(#new-project-template-baroque-organ) .modal-foot button.primary')
      .click();
    await page.locator('.modal-scrim.is-launcher-layer').waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.__sonareDebug?.initialized() === true);
    if (await page.locator('.tour-tooltip').isVisible()) {
      await page.locator('.tour-tooltip .tour-skip').click();
      await page.locator('.tour-overlay').waitFor({ state: 'detached' });
    }
    const template = await page.evaluate(() => window.__sonareDebug.projectDocument());
    if (
      template.tempoSegments[0]?.bpm !== 80 ||
      template.scaleHighlight?.rootPc !== 2 ||
      template.scaleHighlight?.modeMask !== 2477 ||
      template.sections.length !== 6
    ) {
      fail('Baroque organ template lost tempo, D harmonic minor, or its six sections');
    }
    if (
      template.tracks.length !== 4 ||
      template.tracks.some(
        (track) =>
          track.instrument?.preset !== 'church-organ' ||
          !track.pitchRange ||
          track.clips[0]?.lengthPpq !== 256,
      )
    ) {
      fail('Baroque organ template lacks four bounded church-organ voices');
    }
    const ids = await page.evaluate(() => window.__sonareDebug.trackIds());

    // A chordless organ project should offer a subject, never a drum groove by
    // default. Develop the subject across the full piece into the first manual.
    await openTracks(page);
    if (await page.locator('.part-row').nth(1).locator('.part-check input').isChecked()) {
      fail('chordless organ project selected drums by default');
    }
    await chooseSinglePart(page, 0, ids[0]);
    await page.locator('.part-row').nth(0).locator('.part-expand').click();
    await page.locator('.part-row').nth(0).locator('input[type="number"]').first().fill('64');
    await page.locator('.generate-confirm').click();
    await closeGeneration(page);
    const subject = await page.evaluate(() => window.__sonareDebug.projectDocument());
    if (trackOf(subject, 'Manual I Soprano').clips[0]?.notes.length === 0) {
      fail('Soprano subject was not generated');
    }
    if (subject.tracks.length !== 4 || subject.tracks[0].instrument?.preset !== 'church-organ') {
      fail('subject generation changed the organ track identity or instrument');
    }

    await page.locator('.track-header').first().click();
    await openTracks(page);
    const counter = page.locator('.part-row').nth(3).locator('.part-check input');
    if (await counter.isDisabled()) fail('counterpoint line is unavailable after the subject');
    await chooseSinglePart(page, 3, ids[1]);
    await page.locator('.generate-confirm').click();
    await closeGeneration(page);
    const twoVoices = await page.evaluate(() => window.__sonareDebug.projectDocument());
    if (trackOf(twoVoices, 'Manual I Alto').clips[0]?.notes.length === 0) {
      fail('Alto counterpoint line is empty');
    }

    await page.locator('.track-header').first().click();
    await openTracks(page);
    await chooseSinglePart(page, 3, ids[2]);
    await page.locator('.part-row').nth(3).locator('.part-expand').click();
    await page.locator('.part-row').nth(3).locator('.reroll-button').click();
    await page.locator('.generate-confirm').click();
    await closeGeneration(page);
    const threeVoices = await page.evaluate(() => window.__sonareDebug.projectDocument());
    if (trackOf(threeVoices, 'Manual II Tenor').clips[0]?.notes.length === 0) {
      fail('Tenor variation is empty');
    }

    // A harmonic foundation can be added after the contrapuntal subject. The
    // bass generator then writes into the prepared pedal lane in place.
    await page.locator('#menubar-trigger-generate').click();
    await page.locator('[id="menubar-generate-generate.progression"]').click();
    await page.locator('.bars-input').fill('64');
    await page.locator('.generate-confirm').click();
    await page.locator('.continue-tracks').click();
    await page.locator('.part-list').waitFor({ state: 'visible' });
    await chooseSinglePart(page, 2, ids[3]);
    await page.locator('.generate-confirm').click();
    await closeGeneration(page);
    const fourVoices = await page.evaluate(() => window.__sonareDebug.projectDocument());
    if (trackOf(fourVoices, 'Pedal Bass').clips[0]?.notes.length === 0) {
      fail('Pedal bass was not generated');
    }
    if (
      fourVoices.tracks.length !== 4 ||
      fourVoices.tracks.some((track) => track.instrument?.preset !== 'church-organ')
    ) {
      fail('generating organ voices created extra tracks or changed their sound');
    }
    const duration = (256 * 60) / fourVoices.tempoSegments[0].bpm;
    if (duration !== 192) fail(`organ song duration should be 3:12, got ${duration}s`);

    await page.locator('.track-header').first().click();
    await openTracks(page);
    await chooseSinglePart(page, 0, ids[0]);
    await page.locator('.part-row').nth(0).locator('.part-expand').click();
    await page.locator('.part-row').nth(0).locator('input[type="number"]').first().fill('64');
    await page.locator('.part-row').nth(0).locator('.reroll-button').click();
    await page.locator('.generate-confirm').click();
    await closeGeneration(page);
    const varied = await page.evaluate(() => window.__sonareDebug.projectDocument());
    if (
      JSON.stringify(trackOf(varied, 'Manual I Soprano').clips[0].notes) ===
      JSON.stringify(trackOf(fourVoices, 'Manual I Soprano').clips[0].notes)
    ) {
      fail('reroll did not vary the organ subject');
    }
    for (const name of ['Manual I Alto', 'Manual II Tenor', 'Pedal Bass']) {
      if (JSON.stringify(trackOf(varied, name)) !== JSON.stringify(trackOf(fourVoices, name))) {
        fail(`${name} changed when only the Soprano subject was rerolled`);
      }
    }

    // Inspect the generated counterpoint in the real piano roll. The profile
    // switch and note explanation must work on the organ's own voice tracks.
    await page.locator('.dock-tabs button:has-text("Piano Roll")').click();
    await page.locator('.legend-chip').filter({ hasText: 'Manual I Alto' }).click();
    await page.locator('.zoom-cluster .fit-pair .fit-btn').nth(1).click();
    await page.locator('.fx-toggle[aria-expanded]').last().click();
    await page.locator('.guidance-legend').waitFor({ state: 'visible' });
    await page
      .locator('.guidance-legend [role="radiogroup"]')
      .nth(1)
      .locator('button')
      .first()
      .click();
    await page.locator('.guidance-legend .legend-close').click();
    const point = await page.evaluate(() => {
      const grid = document.querySelector('.note-grid');
      const props = grid?.__vueParentComponent?.props;
      if (!grid || !props?.range) return null;
      const rect = grid.getBoundingClientRect();
      for (const note of props.notes ?? []) {
        const x = props.range.ppqToX(note.startPpq + Math.min(0.1, note.durationPpq / 2));
        const y = props.range.pitchToY(note.pitch) + props.range.rowHeight / 2;
        if (x < 10 || x > rect.width - 10 || y < 10 || y > rect.height - 10) continue;
        return { x: rect.left + x, y: rect.top + y };
      }
      return null;
    });
    if (!point) fail('no generated Alto note is visible for theory guidance');
    else {
      await page.mouse.move(point.x, point.y);
      await page.locator('.note-grid-theory-card').waitFor({ state: 'visible' });
      const labels = await page
        .locator('.note-grid-theory-card .theory-card-label')
        .allTextContents();
      if (!labels.some((label) => /Counterpoint|対位法/.test(label))) {
        fail(`organ note lacks a counterpoint explanation: ${labels.join(', ')}`);
      }
    }

    const preview = await page.evaluate(() =>
      window.__sonareDebug.exportProbe(false, { startPpq: 0, endPpq: 4 }),
    );
    if (preview.totalFrames <= 0 || preview.peakDb < -50) {
      fail(`organ voices produced inaudible preview: ${JSON.stringify(preview)}`);
    }
    if (errors.length > 0) fail(`browser errors: ${errors.join(' | ')}`);
    console.info('Baroque organ: four church-organ voices at 80 BPM with audible one-bar preview');
  } finally {
    page.off('pageerror', onError);
  }
}
