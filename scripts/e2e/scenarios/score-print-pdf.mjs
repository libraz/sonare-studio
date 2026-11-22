import { downloadBytes } from '../wav-inspection.mjs';

/**
 * Score print and PDF: Print hands the browser one engraved SVG per page, and
 * PDF downloads a document with the same number of pages.
 */
export const name = 'score-print-pdf';

const action = (page, label) =>
  page.locator('button.tb-action').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) });

export async function run(ctx) {
  const { page, fail } = ctx;

  if ((await page.evaluate(() => window.__sonareDebug.noteCount())) === 0) {
    throw new Error('the active clip has no notes to engrave');
  }
  // The dock tab toggles the panel; the score scenario may already have opened it.
  if ((await page.locator('.score-host').count()) === 0) {
    await page.click('.dock-tabs button:has-text("Score")');
  }
  await page
    .locator('.score-body svg g.note')
    .first()
    .waitFor({ state: 'attached', timeout: 120000 });
  await page.waitForFunction(
    () => {
      const buttons = [...document.querySelectorAll('button.tb-action')];
      return ['Print', 'PDF'].every((label) => {
        const button = buttons.find((entry) => entry.textContent?.trim() === label);
        return button && !button.disabled;
      });
    },
    null,
    { timeout: 120000 },
  );

  // Print: the browser's print call is replaced so the page it would print is captured.
  await page.evaluate(() => {
    window.__printed = null;
    window.print = () => {
      const root = document.querySelector('.sonare-print-root');
      const pages = [...(root?.querySelectorAll('.sonare-print-page') ?? [])];
      window.__printed = {
        pages: pages.length,
        pagesWithSvg: pages.filter((entry) => entry.querySelector(':scope > svg')).length,
        noteGroups: root?.querySelectorAll('g.note').length ?? 0,
        pageRule: [...document.head.querySelectorAll('style')].some((style) =>
          /@page\s*{\s*size:\s*[\d.]+mm\s+[\d.]+mm/.test(style.textContent ?? ''),
        ),
      };
      window.dispatchEvent(new Event('afterprint'));
    };
  });
  await action(page, 'Print').click();
  await page.waitForFunction(() => window.__printed !== null, null, { timeout: 60000 });
  const printed = await page.evaluate(() => window.__printed);
  if (
    printed.pages < 1 ||
    printed.pagesWithSvg !== printed.pages ||
    printed.noteGroups < 1 ||
    !printed.pageRule
  ) {
    fail(`print did not hand over engraved pages: ${JSON.stringify(printed)}`);
  } else {
    console.info(`print handed over ${printed.pages} page(s), ${printed.noteGroups} note groups`);
  }
  await page.waitForFunction(() => document.querySelector('.sonare-print-root') === null, null, {
    timeout: 5000,
  });

  // PDF: the download is a real PDF whose page count matches what print produced.
  const downloaded = page.waitForEvent('download', { timeout: 120000 });
  await action(page, 'PDF').click();
  const download = await downloaded;
  const bytes = await downloadBytes(download);
  const text = bytes.toString('latin1');
  const pdf = {
    filename: download.suggestedFilename(),
    byteLength: bytes.length,
    header: text.slice(0, 5),
    trailer: text.trimEnd().slice(-5),
    pageObjects: (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length,
    footers: [...text.matchAll(/\(Page (\d+) \/ (\d+)\)/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]),
  };
  if (pdf.header !== '%PDF-' || pdf.trailer !== '%%EOF' || pdf.byteLength < 2000) {
    fail(`the PDF download is not a populated PDF: ${JSON.stringify(pdf)}`);
  } else if (pdf.pageObjects !== printed.pages) {
    fail(`the PDF has ${pdf.pageObjects} page(s), print handed over ${printed.pages}`);
  } else if (
    pdf.footers.length !== printed.pages ||
    pdf.footers.some(([, total]) => total !== printed.pages)
  ) {
    fail(
      `the PDF page footers disagree with ${printed.pages} page(s): ${JSON.stringify(pdf.footers)}`,
    );
  } else {
    console.info(`PDF ${pdf.filename}: ${pdf.byteLength} bytes, ${pdf.pageObjects} page(s)`);
  }
}
