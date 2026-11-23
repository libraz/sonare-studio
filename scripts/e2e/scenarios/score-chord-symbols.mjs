import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';

/**
 * Score chord symbols: Estimate progression in the Lists tab fills the chord
 * track from block triads, and the Chords toggle in the Score toolbar engraves
 * the same symbols above the staff. Switching the toggle off removes them.
 */
export const name = 'score-chord-symbols';

const EXPECTED = ['C', 'F', 'G', 'C'];
const TRIADS = [
  [60, 64, 67],
  [65, 69, 72],
  [67, 71, 74],
  [60, 64, 67],
];
const NOTES = TRIADS.flatMap((pitches, bar) =>
  pitches.map((pitch) => ({ pitch, startPpq: bar * 4, durationPpq: 4 })),
);

const engravedChords = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.score-body svg g.harm')].map((el) =>
      (el.textContent ?? '').replace(/\s+/g, ''),
    ),
  );

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await openEmptyProject(page, baseUrl);
    await skipTour(page);
    await page.evaluate(
      (notes) => window.__sonareDebug.addNotedMidiClip('Chord symbols', 0, 16, notes),
      NOTES,
    );

    await page.click('.dock-tabs button:has-text("Lists")');
    await page.locator('.list-tab[data-tab-id="chords"]').click();
    await page.locator('.list-actions button').filter({ hasText: 'Estimate progression' }).click();
    await page.waitForFunction(() => window.__sonareDebug.chordRanges().length === 4, null, {
      timeout: 20000,
    });
    const tracked = (await page.locator('.chord-row .cell-name').allTextContents()).map((n) =>
      n.trim(),
    );
    if (tracked.join(',') !== EXPECTED.join(',')) {
      fail(`the chord track reads ${tracked.join(',')}, expected ${EXPECTED.join(',')}`);
    }

    // The first Score open loads the engraver wasm worker.
    await page.click('.dock-tabs button:has-text("Score")');
    await page
      .locator('.score-body svg g.note')
      .first()
      .waitFor({ state: 'attached', timeout: 120000 });
    const before = await engravedChords(page);
    if (before.length !== 0) fail(`chord symbols engraved with the toggle off: ${before}`);

    const toggle = page
      .locator('.score-toolbar button[aria-pressed]')
      .filter({ hasText: /^Chords$/ });
    await toggle.click();
    await page.waitForFunction(
      () => document.querySelectorAll('.score-body svg g.harm').length > 0,
      null,
      { timeout: 60000 },
    );
    const symbols = await engravedChords(page);
    if (symbols.join(',') !== EXPECTED.join(',')) {
      fail(`the score engraves ${symbols.join(',')}, expected ${EXPECTED.join(',')}`);
    }

    await toggle.click();
    await page.waitForFunction(
      () => document.querySelectorAll('.score-body svg g.harm').length === 0,
      null,
      { timeout: 60000 },
    );
    console.info(`score chord symbols: track ${tracked.join(' ')}, engraved ${symbols.join(' ')}`);
  } finally {
    await context.close();
  }
}
