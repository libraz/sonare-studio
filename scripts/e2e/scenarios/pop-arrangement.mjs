import { makeWavBytes } from '../harness.mjs';

/** Repeat a generated pop section with its chords, MIDI parts and reference audio. */
export const name = 'pop-arrangement';

/** Waits until every debounced audio-schedule apply and MIDI sync has finished. */
const settle = (page) => page.evaluate(() => window.__sonareDebug.whenEngineSyncIdle());
const scheduledIds = (page) => page.evaluate(() => window.__sonareDebug.scheduledClipIds());

export async function run({ page, fail }) {
  const completedDialog = page.locator('.modal-card:has(.track-done)');
  if (await completedDialog.isVisible()) {
    await completedDialog.locator('.modal-foot button:not(.primary)').click();
    await completedDialog.waitFor({ state: 'detached' });
  }

  const before = await page.evaluate(() => ({
    chords: window.__sonareDebug.chordRanges(),
    clips: window.__sonareDebug.clipRanges(),
  }));
  if (before.chords.length < 4 || before.chords.at(-1)?.endPpq !== 16) {
    fail(`generated four-bar chord progression missing: ${JSON.stringify(before.chords)}`);
  }

  // A reference recording added at the start of the song must take part in
  // the same section edit as the generated MIDI parts.
  await page.evaluate(() => window.__sonareDebug.seekPpq(0));
  await page.click('.dock-tabs button:has-text("Media")');
  await page.setInputFiles('.media-browser .file-input', {
    name: 'pop-reference.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from(makeWavBytes(0.5, 440)),
  });
  const asset = page.locator('.media-browser .asset-row', { hasText: 'pop-reference' }).first();
  await asset.waitFor({ state: 'visible', timeout: 20000 });
  await asset.locator('.add-button').click();
  await page.waitForFunction(
    (count) => window.__sonareDebug.clipCount() === count + 1,
    before.clips.length,
  );
  await settle(page);
  const scheduledBefore = await scheduledIds(page);
  const withAudio = await page.evaluate(() => window.__sonareDebug.clipRanges());
  const audio = withAudio.find((clip) => clip.kind === 'audio');
  if (audio?.startPpq !== 0) fail(`reference audio missed bar one: ${JSON.stringify(audio)}`);

  // Create the four-bar section through the arrangement lane, then use its
  // real context menu. This exercises the generator → arrangement handoff.
  const lane = page.locator('.section-lane');
  await lane.dblclick({ position: { x: 20, y: 10 } });
  const band = lane.locator('.section-band').first();
  await band.waitFor({ state: 'visible' });
  await band.click({ button: 'right', position: { x: 40, y: 10 } });
  await page.locator('.context-menu-item[data-menu-item-id="duplicate-section"]').click();
  await page.waitForFunction(
    (count) => window.__sonareDebug.clipCount() === count * 2,
    withAudio.length,
  );
  // Settle before undoing, so the engine has scheduled the copy the undo must remove.
  await settle(page);
  const scheduledRepeated = await scheduledIds(page);
  // The original stays scheduled as it was; only the copy is added.
  if (
    scheduledRepeated.length !== scheduledBefore.length * 2 ||
    scheduledBefore.some((id) => !scheduledRepeated.includes(id))
  ) {
    fail(
      `engine schedule after the duplicate is ${JSON.stringify(scheduledRepeated)}, expected ${JSON.stringify(scheduledBefore)} plus the copy`,
    );
  }
  const repeated = await page.evaluate(() => ({
    chords: window.__sonareDebug.chordRanges(),
    clips: window.__sonareDebug.clipRanges(),
  }));
  const chordSignature = (chord) =>
    `${chord.startPpq}:${chord.endPpq}:${chord.rootPc}:${chord.quality}`;
  const secondChords = repeated.chords.filter((chord) => chord.startPpq >= 16);
  if (
    secondChords.length !== before.chords.length ||
    secondChords.some(
      (chord, index) =>
        chordSignature(chord) !==
        chordSignature({
          ...before.chords[index],
          startPpq: before.chords[index].startPpq + 16,
          endPpq: before.chords[index].endPpq + 16,
        }),
    )
  ) {
    fail(`repeated section lost its chord changes: ${JSON.stringify(repeated.chords)}`);
  }
  for (const original of withAudio) {
    const copy = repeated.clips.find(
      (clip) =>
        clip.id !== original.id &&
        clip.trackId === original.trackId &&
        clip.kind === original.kind &&
        clip.startPpq === original.startPpq + 16 &&
        clip.lengthPpq === original.lengthPpq,
    );
    if (!copy) fail(`section duplicate lost or misaligned a part: ${JSON.stringify(original)}`);
  }
  console.info(
    `section duplicated: ${withAudio.length} aligned MIDI/audio clips and ${before.chords.length} chords`,
  );

  await page.keyboard.press('Meta+z');
  await page.waitForFunction(
    (count) => window.__sonareDebug.clipCount() === count,
    withAudio.length,
  );
  await settle(page);
  // Undo removes only the copy, leaving the original's engine clip in place.
  const scheduledUndone = await scheduledIds(page);
  if (JSON.stringify(scheduledUndone) !== JSON.stringify(scheduledBefore)) {
    fail(
      `Undo left the engine schedule at ${JSON.stringify(scheduledUndone)}, expected ${JSON.stringify(scheduledBefore)}`,
    );
  }
  if (
    (await page.evaluate(() => window.__sonareDebug.chordRanges())).length !== before.chords.length
  ) {
    fail('Undo did not restore the original chord track with the clips');
  }
  await page.keyboard.press('Meta+Shift+z');
  await page.waitForFunction(
    (count) => window.__sonareDebug.clipCount() === count * 2,
    withAudio.length,
  );
  await settle(page);
  if ((await scheduledIds(page)).length !== scheduledBefore.length * 2) {
    fail('Redo did not reschedule the duplicated audio on the engine');
  }
  if (
    (await page.evaluate(() => window.__sonareDebug.chordRanges())).length !==
    before.chords.length * 2
  ) {
    fail('Redo did not restore the repeated chord track with the clips');
  }
}
