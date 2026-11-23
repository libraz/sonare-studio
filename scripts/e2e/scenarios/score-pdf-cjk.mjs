import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';
import { inspectPdfFonts } from '../pdf-inspection.mjs';
import { downloadBytes } from '../wav-inspection.mjs';

/**
 * Score PDF with Japanese text: a track named in Japanese engraves its part
 * name into the PDF through an embedded CID font whose ToUnicode map carries
 * every code point of the name. Runs in its own context so the shared page's
 * project keeps its tracks.
 */
export const name = 'score-pdf-cjk';

const PART_NAME = 'ピアノ右手 Piano';

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage, { acceptDownloads: true });
  try {
    await openEmptyProject(page, baseUrl);
    await skipTour(page);
    await page.evaluate(
      (partName) =>
        window.__sonareDebug.addNotedMidiClip(partName, 0, 16, [
          { pitch: 60, startPpq: 0, durationPpq: 4 },
          { pitch: 64, startPpq: 4, durationPpq: 4 },
        ]),
      PART_NAME,
    );
    await page.click('.dock-tabs button:has-text("Score")');
    await page
      .locator('.score-body svg g.note')
      .first()
      .waitFor({ state: 'attached', timeout: 120000 });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('button.tb-action')].some(
          (button) => button.textContent?.trim() === 'PDF' && !button.disabled,
        ),
      null,
      { timeout: 120000 },
    );
    const downloaded = page.waitForEvent('download', { timeout: 120000 });
    await page
      .locator('button.tb-action')
      .filter({ hasText: /^\s*PDF\s*$/ })
      .click();
    const fonts = inspectPdfFonts(await downloadBytes(await downloaded));
    const missing = [...PART_NAME]
      .map((character) => character.codePointAt(0))
      .filter((codePoint) => codePoint !== 0x20 && !fonts.mappedCodePoints.has(codePoint))
      .map((codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`);
    if (fonts.type0Fonts < 1 || fonts.cidFonts < 1 || fonts.fontFiles < 1) {
      fail(
        `the PDF embeds no CID font for Japanese text: ${JSON.stringify({ ...fonts, mappedCodePoints: fonts.mappedCodePoints.size })}`,
      );
    } else if (missing.length > 0) {
      fail(`the PDF's embedded font maps none of ${missing.join(' ')} from the part name`);
    } else {
      console.info(`PDF embeds ${fonts.cidFonts} CID font(s) carrying "${PART_NAME}"`);
    }
  } finally {
    await context.close();
  }
}
