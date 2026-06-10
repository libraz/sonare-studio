/**
 * E2E smoke test for the piano roll editor.
 *
 * Drives a headless Chrome against a running dev server and verifies that the
 * editor renders, double-click creates a note, and Cmd+Z undoes it (via the
 * dev-only window.__sonareDebug hook exposed by App.vue).
 *
 * Playwright is resolved from /tmp/node_modules. Usage:
 *   yarn dev --port 5199   # in the project root, in the background
 *   node scripts/e2e-smoke.mjs [baseUrl]
 */
import { createRequire } from 'node:module';

const require = createRequire('/tmp/node_modules/');
const { chromium } = require('playwright');

const baseUrl = process.argv[2] ?? 'http://localhost:5199';

/** Fails the run with a message. */
function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error('pageerror:', err.message));

  await page.goto(baseUrl, { waitUntil: 'load' });

  // Wait for the project store to initialize and the demo phrase to be seeded.
  await page.waitForFunction(
    () => window.__sonareDebug?.initialized() === true && window.__sonareDebug.noteCount() > 0,
    null,
    { timeout: 30000 },
  );
  const seededCount = await page.evaluate(() => window.__sonareDebug.noteCount());
  console.info(`store initialized, seeded notes: ${seededCount}`);

  // The note grid renders two stacked canvases; assert nonzero size.
  const canvas = page.locator('.note-grid canvas').first();
  await canvas.waitFor({ state: 'visible', timeout: 10000 });
  const box = await canvas.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    fail(`piano roll canvas has no size: ${JSON.stringify(box)}`);
  } else {
    console.info(`canvas size: ${Math.round(box.width)}x${Math.round(box.height)}`);
  }

  // Double-click an empty top-left cell (high pitches, before the phrase) to create a note.
  await page.mouse.dblclick(box.x + box.width * 0.6, box.y + 12);
  await page.waitForFunction(
    (before) => window.__sonareDebug.noteCount() === before + 1,
    seededCount,
    { timeout: 5000 },
  );
  console.info(`note created: ${seededCount} -> ${seededCount + 1}`);

  // Cmd+Z must undo the creation.
  await page.keyboard.press('Meta+z');
  await page.waitForFunction((before) => window.__sonareDebug.noteCount() === before, seededCount, {
    timeout: 5000,
  });
  console.info(`undo restored note count: ${seededCount}`);

  if (process.exitCode !== 1) console.info('E2E SMOKE PASS');
} catch (err) {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  await browser.close();
}
