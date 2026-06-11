/**
 * E2E smoke test for the studio shell.
 *
 * Drives a headless Chrome against a running dev server and verifies that the
 * piano roll renders, double-click creates a note, Cmd+Z undoes it, the score
 * panel engraves, a track and a clip can be created in the arrangement view,
 * and a project saved to OPFS is restored after a page reload (via the
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

  // The shell offers to restore an autosave with a confirm() on boot. Decline
  // on the first load (start from the demo project) and accept after the
  // OPFS-save step below so the reload restores the saved state.
  let acceptRestore = false;
  page.on('dialog', (dialog) => {
    if (dialog.type() === 'confirm' && dialog.message().includes('Restore')) {
      void (acceptRestore ? dialog.accept() : dialog.dismiss());
    } else {
      void dialog.accept();
    }
  });

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

  // Toggle the score panel and wait for the engraved SVG. On a cold dev
  // server the first open transforms and boots the ~8 MB Verovio wasm worker,
  // so allow a generous timeout.
  await page.click('.dock-tabs button:has-text("Score")');
  const scoreNote = page.locator('.score-body svg g.note').first();
  await scoreNote.waitFor({ state: 'attached', timeout: 120000 });
  const noteGroups = await page.locator('.score-body svg g.note').count();
  console.info(`score rendered: ${noteGroups} note group(s)`);

  const indicator = ((await page.locator('.score-page-indicator').textContent()) ?? '').trim();
  if (!/^1 \/ \d+$/.test(indicator)) {
    fail(`unexpected score page indicator: "${indicator}"`);
  } else {
    console.info(`score page indicator: ${indicator}`);
  }

  // Add a track via the arrangement header column.
  await page.click('.track-headers .add-track');
  await page.waitForFunction(() => window.__sonareDebug.trackCount() === 2, null, {
    timeout: 5000,
  });
  const headerCount = await page.locator('.track-headers .track-header').count();
  if (headerCount !== 2) {
    fail(`expected 2 track headers after adding a track, got ${headerCount}`);
  } else {
    console.info('track added: 2 track headers');
  }

  // Double-click lane 2 of the arrangement canvas to create a one-bar clip.
  const clipsBefore = await page.evaluate(() => window.__sonareDebug.clipCount());
  const arrangeCanvas = page.locator('.arrangement-canvas');
  await arrangeCanvas.waitFor({ state: 'visible', timeout: 5000 });
  const arrangeBox = await arrangeCanvas.boundingBox();
  if (!arrangeBox || arrangeBox.width <= 0 || arrangeBox.height <= 0) {
    fail(`arrangement canvas has no size: ${JSON.stringify(arrangeBox)}`);
  }
  // Lane 2 starts below the 28 px ruler plus one 56 px lane; aim mid-lane.
  await page.mouse.dblclick(arrangeBox.x + arrangeBox.width * 0.3, arrangeBox.y + 28 + 56 + 28);
  await page.waitForFunction(
    (before) => window.__sonareDebug.clipCount() === before + 1,
    clipsBefore,
    { timeout: 5000 },
  );
  console.info(`clip created on lane 2: ${clipsBefore} -> ${clipsBefore + 1}`);

  // Save the project to OPFS via the project menu, then reload the page and
  // accept the autosave-restore prompt: the two-track project must survive.
  await page.click('.project-menu .menu-trigger');
  await page.click('.menu-pop .menu-save');
  await page.waitForSelector('.autosave-state', { timeout: 15000 });
  console.info('project saved to OPFS');

  acceptRestore = true;
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(
    () => window.__sonareDebug?.initialized() === true && window.__sonareDebug.trackCount() === 2,
    null,
    { timeout: 30000 },
  );
  const restoredHeaders = await page.locator('.track-headers .track-header').count();
  if (restoredHeaders !== 2) {
    fail(`expected 2 track headers after reload, got ${restoredHeaders}`);
  } else {
    console.info('project restored after reload: 2 track headers');
  }

  if (process.exitCode !== 1) console.info('E2E SMOKE PASS');
} catch (err) {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  await browser.close();
}
