/**
 * Step input: with music typing on and step input armed, QWERTY keys write
 * notes at the cursor, which advances by the grid step; Tab rests and
 * Shift+Tab steps back.
 */
import { remainsFalse } from '../harness.mjs';
export const name = 'step-input';

const TOLERANCE_PPQ = 1e-6;

const typedNotes = (page) =>
  page.evaluate(() =>
    window.__sonareDebug
      .activeNotes()
      // The clip's seed note is C4; everything typed here avoids that pitch.
      .filter((note) => note.pitch !== 60)
      .map((note) => ({
        pitch: note.pitch,
        startPpq: note.startPpq,
        durationPpq: note.durationPpq,
      }))
      .sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch),
  );

const toggle = (page, label) =>
  page
    .locator('button')
    .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) })
    .first();

export async function run(ctx) {
  const { page, fail } = ctx;
  const trackCountBefore = await page.evaluate(() => window.__sonareDebug.trackCount());
  const activeClipBefore = await page.evaluate(() => window.__sonareDebug.activeClipId());
  const trackId = await page.evaluate(() => {
    const { trackId: id } = window.__sonareDebug.addMidiTestClip('Step input', 0);
    window.__sonareDebug.seekPpq(0);
    return id;
  });
  await page.click('.dock-tabs button:has-text("Piano Roll")');

  // Music typing alone only previews: nothing is written until step input is armed.
  await toggle(page, 'Music typing').click();
  const notesBeforePreview = await page.evaluate(() => window.__sonareDebug.noteCount());
  await page.keyboard.press('d');
  const previewWrote = !(await remainsFalse(
    page,
    (before) => window.__sonareDebug.noteCount() !== before,
    notesBeforePreview,
    150,
  ));
  if (previewWrote || (await typedNotes(page)).length !== 0) {
    fail('a typed key wrote a note with step input off');
  }

  await toggle(page, 'Step input').click();
  const cursor = page.locator('.step-cursor');
  await cursor.waitFor({ state: 'visible', timeout: 5000 });
  const cursorAtStart = ((await cursor.textContent()) ?? '').trim();

  // E4 F4 G4, a rest, then A4.
  for (const key of ['d', 'f', 'g']) await page.keyboard.press(key);
  await page.waitForFunction(() => window.__sonareDebug.noteCount() === 4, null, { timeout: 5000 });
  await page.keyboard.press('Tab');
  await page.keyboard.press('h');
  await page.waitForFunction(() => window.__sonareDebug.noteCount() === 5, null, { timeout: 5000 });

  const written = await typedNotes(page);
  const step = written[1]?.startPpq - written[0]?.startPpq;
  const expectedPitches = [64, 65, 67, 69];
  const expectedStarts = [0, step, 2 * step, 4 * step];
  if (
    !(step > 0) ||
    written.length !== 4 ||
    written.some(
      (note, index) =>
        note.pitch !== expectedPitches[index] ||
        Math.abs(note.startPpq - expectedStarts[index]) > TOLERANCE_PPQ ||
        Math.abs(note.durationPpq - step) > TOLERANCE_PPQ,
    )
  ) {
    fail(
      `step input wrote ${JSON.stringify(written)}, expected pitches ${expectedPitches} on a ${step} grid with a one-step rest`,
    );
  } else {
    console.info(`step input wrote ${written.length} notes on a ${step} PPQ grid with a rest`);
  }
  const cursorAfter = ((await cursor.textContent()) ?? '').trim();
  if (cursorAfter === cursorAtStart) fail(`the step cursor did not move: ${cursorAfter}`);

  // Shift+Tab steps back one grid step, so the next note lands on the last one's start.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('j');
  await page.waitForFunction(() => window.__sonareDebug.noteCount() === 6, null, { timeout: 5000 });
  const stepped = (await typedNotes(page)).find((note) => note.pitch === 71);
  if (!stepped || Math.abs(stepped.startPpq - 4 * step) > TOLERANCE_PPQ) {
    fail(`Shift+Tab did not step the cursor back: ${JSON.stringify(stepped)}`);
  }

  // Octave down shifts the home row by twelve semitones.
  await page.keyboard.press('z');
  await page.keyboard.press('s');
  await page.waitForFunction(() => window.__sonareDebug.noteCount() === 7, null, { timeout: 5000 });
  if (!(await typedNotes(page)).some((note) => note.pitch === 50)) {
    fail('the octave-down key did not lower the typed pitch');
  }

  await toggle(page, 'Step input').click();
  await toggle(page, 'Music typing').click();
  await page.keyboard.press('a');
  const wroteAfterOff = !(await remainsFalse(
    page,
    () => window.__sonareDebug.noteCount() !== 7,
    undefined,
    150,
  ));
  if (wroteAfterOff) {
    fail('a typed key wrote a note after step input and music typing were switched off');
  }

  await page.evaluate((id) => window.__sonareDebug.removeTrack(id), trackId);
  await page.waitForFunction(
    (count) => window.__sonareDebug.trackCount() === count,
    trackCountBefore,
    { timeout: 5000 },
  );
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), activeClipBefore);
}
