/** Use a J-pop song template and regenerate the second pre-chorus in place. */
export const name = 'jpop-section-variations';

function trackOf(document, name) {
  const track = document.tracks.find((entry) => entry.name === name);
  if (!track) throw new Error(`missing ${name} track`);
  return track;
}

function notesIn(track, firstPpq, endPpq) {
  return track.clips
    .flatMap((clip) =>
      clip.notes.map((note) => ({
        pitch: note.pitch,
        channel: note.channel,
        velocity: note.velocity,
        startPpq: clip.startPpq + note.startPpq - clip.sourceOffsetPpq,
        durationPpq: note.durationPpq,
      })),
    )
    .filter((note) => note.startPpq >= firstPpq && note.startPpq < endPpq)
    .sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch || a.velocity - b.velocity);
}

async function openChordGenerator(page) {
  await page.locator('#menubar-trigger-generate').click();
  await page.locator('[id="menubar-generate-generate_2e_progression"]').click();
}

async function openPrechorusDrums(page) {
  await page.locator('.section-lane').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Meta+Shift+f');
  await page.waitForFunction(() => document.querySelectorAll('.section-band').length >= 8);
  const section = page.locator('.section-band').nth(5);
  await section.waitFor({ state: 'visible' });
  await section.click({ button: 'right' });
  await page.locator('.context-menu-item[data-menu-item-id="regenerate-section-drums"]').click();
  await page.locator('.drum-range-panel').waitFor({ state: 'visible' });
}

export async function run({ page, baseUrl, fail }) {
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on('pageerror', onError);
  try {
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.locator('[data-testid="start-new"]').click();
    await page.locator('#new-project-template-jpop').click();
    await page
      .locator('.modal-card:has(#new-project-template-jpop) .modal-foot button.primary')
      .click();
    await page.locator('.modal-scrim.is-launcher-layer').waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.__sonareDebug?.initialized() === true);
    if (await page.locator('.tour-tooltip').isVisible()) {
      await page.locator('.tour-tooltip .tour-skip').click();
      await page.locator('.tour-overlay').waitFor({ state: 'detached' });
    }
    const template = await page.evaluate(() => window.__sonareDebug.projectDocument());
    if (template.tempoSegments[0]?.bpm !== 120 || template.sections.length !== 8) {
      fail('J-pop template did not provide 120 BPM and eight sections');
    }
    const section = template.sections[5];
    if (section.name !== 'Pre-chorus' || section.startPpq !== 256 || section.endPpq !== 288) {
      fail(`second pre-chorus is misplaced: ${JSON.stringify(section)}`);
    }
    if (template.tracks.some((track) => track.clips[0]?.lengthPpq !== 384)) {
      fail('J-pop template tracks do not span 96 bars');
    }

    await openChordGenerator(page);
    await page.locator('.bars-input').fill('64');
    await page.locator('.generate-confirm').click();
    await page.locator('.continue-tracks').waitFor({ state: 'visible' });
    await page
      .locator('.modal-card:has(.continue-tracks) .modal-foot button:not(.primary)')
      .click();
    await page.locator('.modal-card:has(.continue-tracks)').waitFor({ state: 'detached' });
    await openChordGenerator(page);
    await page
      .locator('.segment[role="radio"]')
      .filter({ hasText: /Append|追加/ })
      .click();
    await page.locator('.bars-input').fill('32');
    await page.locator('.generate-confirm').click();
    await page.locator('.continue-tracks').click();
    await page.locator('.part-list').waitFor({ state: 'visible' });

    const ids = await page.evaluate(() => window.__sonareDebug.trackIds());
    for (const [partIndex, trackIndex] of [
      [1, 0],
      [2, 1],
      [4, 2],
    ]) {
      await page
        .locator('.part-row')
        .nth(partIndex)
        .locator('.part-target')
        .selectOption(`replace:${ids[trackIndex]}`);
    }
    await page.locator('.generate-confirm').click();
    await page.locator('.track-done').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('.modal-card:has(.track-done) .modal-foot button:not(.primary)').click();
    await page.locator('.modal-card:has(.track-done)').waitFor({ state: 'detached' });

    const before = await page.evaluate(() => window.__sonareDebug.projectDocument());
    if (before.tracks.length !== 4 || trackOf(before, 'Drums').clips[0]?.notes.length === 0) {
      fail('generation did not fill the four template tracks in place');
    }
    for (const name of ['Bass', 'Backing']) {
      if (trackOf(before, name).clips[0]?.notes.length === 0)
        fail(`${name} accompaniment is empty`);
    }

    await openPrechorusDrums(page);
    if ((await page.locator('.drum-range-start').inputValue()) !== '65') {
      fail('section action did not select bar 65');
    }
    if ((await page.locator('.drum-range-length').inputValue()) !== '8') {
      fail('section action did not select eight pre-chorus bars');
    }
    const sectionKind = await page
      .locator('.part-row')
      .nth(1)
      .locator('select:has(option[value="prechorus"])')
      .first()
      .inputValue();
    const nextKind = await page
      .locator('.part-row')
      .nth(1)
      .locator('select:has(option[value="same"])')
      .inputValue();
    if (sectionKind !== 'prechorus' || nextKind !== 'chorus') {
      fail(`pre-chorus → chorus context was lost: ${sectionKind} → ${nextKind}`);
    }
    await page.locator('.generate-confirm').click();
    await page.locator('.drum-range-panel').waitFor({ state: 'detached' });
    const built = await page.evaluate(() => window.__sonareDebug.projectDocument());
    const originalDrums = trackOf(before, 'Drums');
    const builtDrums = trackOf(built, 'Drums');
    const outside = (track) => [...notesIn(track, 0, 256), ...notesIn(track, 288, 384)];
    if (JSON.stringify(outside(originalDrums)) !== JSON.stringify(outside(builtDrums))) {
      fail('pre-chorus regeneration changed drums outside bars 65–72');
    }
    if (
      JSON.stringify(notesIn(originalDrums, 256, 288)) ===
      JSON.stringify(notesIn(builtDrums, 256, 288))
    ) {
      fail('pre-chorus regeneration made no drum change');
    }
    for (const name of ['Bass', 'Backing', 'Lead']) {
      if (JSON.stringify(trackOf(before, name)) !== JSON.stringify(trackOf(built, name))) {
        fail(`${name} changed during drum regeneration`);
      }
    }
    if (builtDrums.clips.some((clip) => clip.notes.some((note) => note.channel !== 9))) {
      fail('section variation inserted non-percussion notes');
    }

    await openPrechorusDrums(page);
    await page.locator('.part-row').nth(1).locator('.reroll-button').click();
    await page.locator('.generate-confirm').click();
    await page.locator('.drum-range-panel').waitFor({ state: 'detached' });
    const varied = await page.evaluate(() => window.__sonareDebug.projectDocument());
    const variedDrums = trackOf(varied, 'Drums');
    if (JSON.stringify(outside(builtDrums)) !== JSON.stringify(outside(variedDrums))) {
      fail('reroll changed drums outside the selected section');
    }
    if (
      JSON.stringify(notesIn(builtDrums, 256, 288)) ===
      JSON.stringify(notesIn(variedDrums, 256, 288))
    ) {
      fail('reroll did not create a second pre-chorus variation');
    }
    await page.keyboard.press('Meta+z');
    await page.waitForFunction(
      (expected) =>
        JSON.stringify(window.__sonareDebug.projectDocument().tracks[0].clips[0].notes) ===
        expected,
      JSON.stringify(builtDrums.clips[0].notes),
    );
    await page.keyboard.press('Meta+Shift+z');
    await page.waitForFunction(
      (expected) =>
        JSON.stringify(window.__sonareDebug.projectDocument().tracks[0].clips[0].notes) ===
        expected,
      JSON.stringify(variedDrums.clips[0].notes),
    );
    if (errors.length > 0) fail(`browser errors: ${errors.join(' | ')}`);
    console.info(
      '96-bar J-pop: pre-chorus buildup, section-only reroll, other parts, undo/redo verified',
    );
  } finally {
    page.off('pageerror', onError);
  }
}
