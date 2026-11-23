import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';

/**
 * Reproducible generation: the Project seed field of the Generate dialogs
 * decides the output. The same seed writes the same chords and the same notes
 * in every part twice over; a different seed writes different ones.
 */
export const name = 'generation-seed';

const SEED = 7;
const OTHER_SEED = 4242;
const PARTS = ['Motif', 'Drums', 'Bass', 'Backing'];

const chordsOf = (page) => page.evaluate(() => window.__sonareDebug.chordRanges());

const openGenerateDialog = async (page, itemId) => {
  await page.click('#menubar-trigger-generate');
  await page.click(`[id="menubar-generate-${itemId}"]`);
  await page.locator('.seed-row input').waitFor({ state: 'visible', timeout: 10000 });
};

const setSeed = async (page, seed) => {
  await page.locator('.seed-row input').fill(String(seed));
  await page.locator('.seed-row input').blur();
};

async function generateChords(page, seed) {
  await openGenerateDialog(page, 'generate_2e_progression');
  await setSeed(page, seed);
  await page.locator('.generate-confirm').click();
  await page.locator('.continue-tracks').waitFor({ state: 'visible', timeout: 20000 });
  const chords = await chordsOf(page);
  await page.locator('.modal-foot button:not(.primary)').click();
  return chords;
}

/** Generates the parts onto new tracks and returns those tracks' notes. */
async function generateParts(page, seed) {
  const before = await page.evaluate(() => window.__sonareDebug.trackCount());
  await openGenerateDialog(page, 'generate_2e_tracks');
  await setSeed(page, seed);
  // Counter melody follows the notes already in the project, so it is left out.
  for (const part of PARTS) {
    await page.locator('.part-row').filter({ hasText: part }).locator('.part-check input').check();
  }
  await page.locator('.generate-confirm').click();
  await page.locator('.compose-lead').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('.modal-foot button:not(.primary)').click();
  return page.evaluate((count) => {
    const doc = window.__sonareDebug.projectDocument();
    return {
      storedSeed: doc.generationSeed ?? null,
      tracks: doc.tracks.slice(count).map((track) => ({
        name: track.name,
        notes: track.clips.flatMap((clip) => clip.notes),
      })),
    };
  }, before);
}

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await openEmptyProject(page, baseUrl);
    await skipTour(page);

    const chordsA = await generateChords(page, SEED);
    const chordsB = await generateChords(page, SEED);
    const chordsC = await generateChords(page, OTHER_SEED);
    if (chordsA.length === 0 || JSON.stringify(chordsA) !== JSON.stringify(chordsB)) {
      fail(`seed ${SEED} wrote different chords twice: ${JSON.stringify([chordsA, chordsB])}`);
    }
    if (JSON.stringify(chordsA) === JSON.stringify(chordsC)) {
      fail(`seed ${OTHER_SEED} wrote the same chords as seed ${SEED}`);
    }

    // The parts follow the chord track, so every run reads the same progression.
    const chords = await generateChords(page, SEED);
    if (JSON.stringify(chords) !== JSON.stringify(chordsA)) fail('the chord track did not return');
    const first = await generateParts(page, SEED);
    const second = await generateParts(page, SEED);
    const other = await generateParts(page, OTHER_SEED);
    const noteCount = first.tracks.reduce((sum, track) => sum + track.notes.length, 0);
    if (first.tracks.length !== PARTS.length || noteCount === 0) {
      fail(`the first generation wrote ${first.tracks.length} tracks, ${noteCount} notes`);
    }
    if (first.storedSeed !== SEED || other.storedSeed !== OTHER_SEED) {
      fail(`the document holds seeds ${first.storedSeed} and ${other.storedSeed}`);
    }
    const key = (run) => JSON.stringify(run.tracks.map((track) => [track.name, track.notes]));
    if (key(first) !== key(second)) fail(`seed ${SEED} wrote different notes the second time`);
    const different = first.tracks.filter(
      (track, index) => JSON.stringify(track.notes) !== JSON.stringify(other.tracks[index]?.notes),
    );
    if (different.length === 0) fail(`seed ${OTHER_SEED} wrote the same notes as seed ${SEED}`);
    console.info(
      `seed ${SEED} twice: ${noteCount} identical notes over ${first.tracks.length} tracks; ` +
        `seed ${OTHER_SEED} differs in ${different.length} of ${other.tracks.length} tracks`,
    );
  } finally {
    await context.close();
  }
}
