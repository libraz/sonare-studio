/** Compose a 96-bar J-pop song, then vary only the drums before its chorus. */
export const name = 'jpop-long-form';

async function newEmptyProject(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.locator('[data-testid="start-new"]').click();
  await page.locator('#new-project-template-empty').click();
  await page
    .locator('.modal-card:has(#new-project-template-empty) .modal-foot button.primary')
    .click();
  await page.locator('.modal-scrim.is-launcher-layer').waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.__sonareDebug?.initialized() === true);
  if (await page.locator('.tour-tooltip').isVisible()) {
    await page.locator('.tour-tooltip .tour-skip').click();
    await page.locator('.tour-overlay').waitFor({ state: 'detached' });
  }
}

async function openChordGenerator(page) {
  await page.locator('#menubar-trigger-generate').click();
  await page.locator('[id="menubar-generate-generate.progression"]').click();
}

export async function run({ page, baseUrl, fail }) {
  await newEmptyProject(page, baseUrl);
  await openChordGenerator(page);
  await page.locator('.bars-input').fill('64');
  await page.locator('.generate-confirm').click();
  await page.locator('.continue-tracks').waitFor({ state: 'visible' });
  await page.locator('.modal-card:has(.continue-tracks) .modal-foot button:not(.primary)').click();
  await page.locator('.modal-card:has(.continue-tracks)').waitFor({ state: 'detached' });

  await openChordGenerator(page);
  await page
    .locator('.segment[role="radio"][aria-checked="false"]')
    .filter({ hasText: /Append|追加/ })
    .click();
  await page.locator('.bars-input').fill('32');
  await page.locator('.generate-confirm').click();
  await page.locator('.continue-tracks').click();
  await page.locator('.part-list').waitFor({ state: 'visible' });

  const chords = await page.evaluate(() => window.__sonareDebug.chordRanges());
  if (chords.at(-1)?.endPpq !== 384 || chords.length !== 96) {
    fail(
      `96-bar J-pop progression is incomplete: ${chords.length} chords, end ${chords.at(-1)?.endPpq}`,
    );
  }
  const selected = await page.locator('.part-check input:checked').count();
  if (selected !== 3)
    fail(`J-pop accompaniment did not select drums, bass and backing: ${selected}`);
  await page.locator('.generate-confirm').click();
  await page.locator('.track-done').waitFor({ state: 'visible', timeout: 30000 });
  const beforeLead = await page.evaluate(() => window.__sonareDebug.projectDocument());
  const drums = beforeLead.tracks.find((track) => track.name === 'Drums');
  const bass = beforeLead.tracks.find((track) => track.name === 'Bass');
  const backing = beforeLead.tracks.find((track) => track.name === 'Backing');
  for (const [label, track] of [
    ['drums', drums],
    ['bass', bass],
    ['backing', backing],
  ]) {
    if (track?.clips[0]?.lengthPpq !== 384 || track.clips[0].notes.length === 0) {
      fail(
        `${label} did not cover 96 bars: ${JSON.stringify(track?.clips.map((clip) => clip.lengthPpq))}`,
      );
    }
  }
  if (drums?.clips[0]?.notes.some((note) => note.channel !== 9)) {
    fail('generated J-pop drums have non-percussion MIDI notes');
  }
  await page.locator('.compose-lead').click();
  const fullSong = await page.evaluate(() => window.__sonareDebug.projectDocument());
  if (fullSong.tracks.find((track) => track.name === 'Lead')?.clips[0]?.lengthPpq !== 384) {
    fail('lead melody clip did not span the 96-bar song');
  }
  const seconds = (384 * 60) / fullSong.tempoSegments[0].bpm;
  if (seconds < 180 || seconds > 240) fail(`J-pop duration is not 3–4 minutes: ${seconds}s`);
  console.info(`J-pop song: 96 bars, ${seconds}s, ${fullSong.tracks.length} tracks`);
}
