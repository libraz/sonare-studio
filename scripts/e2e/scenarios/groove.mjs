import { arrangementPoint, notePoint } from '../geometry.mjs';

/**
 * Groove: a feel captured from one clip moves the onsets of another, through
 * both the arrangement clip menu and the piano-roll note menu.
 */
export const name = 'groove';

const SWING_PPQ = 0.1;
const SOURCE_START_PPQ = 0;
const TARGET_START_PPQ = 16;
/** Eighth-note onsets of one bar; the source plays the off-beats late. */
const ONSETS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];
const TOLERANCE_PPQ = 0.01;

const noteStarts = (page) =>
  page.evaluate(() =>
    window.__sonareDebug
      .activeNotes()
      .map((note) => note.startPpq)
      .sort((a, b) => a - b),
  );

const sameStarts = (actual, expected) =>
  actual.length === expected.length &&
  actual.every((value, index) => Math.abs(value - expected[index]) < TOLERANCE_PPQ);

async function addBar(page, label, startPpq, starts) {
  return page.evaluate(
    ({ label: clipName, startPpq: at, starts: onsets }) => {
      const { trackId, clipId } = window.__sonareDebug.addMidiTestClip(clipName, at);
      // The clip's seed note already holds the downbeat.
      for (const start of onsets) {
        if (start !== 0) window.__sonareDebug.addNoteAt(64, start, 0.25);
      }
      return { trackId, clipId };
    },
    { label, startPpq, starts },
  );
}

async function openClipMenu(page, trackId, ppq) {
  const point = await arrangementPoint(page, trackId, ppq);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.locator('.context-menu').first().waitFor({ state: 'visible', timeout: 5000 });
}

async function openRollMenu(page, note) {
  const point = await notePoint(page, note);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.locator('.context-menu').first().waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.context-menu-item[data-menu-item-id="quantize-submenu"]').click();
  await page.locator('.context-submenu').waitFor({ state: 'visible', timeout: 5000 });
}

async function selectAllInRoll(page, note) {
  const point = await notePoint(page, note);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press('Meta+a');
  await page.waitForFunction(
    () => window.__sonareDebug.selectionCount() === window.__sonareDebug.noteCount(),
    null,
    { timeout: 5000 },
  );
}

export async function run(ctx) {
  const { page, fail } = ctx;
  const swung = ONSETS.map((onset, index) => (index % 2 === 1 ? onset + SWING_PPQ : onset));
  const trackCountBefore = await page.evaluate(() => window.__sonareDebug.trackCount());
  const activeClipBefore = await page.evaluate(() => window.__sonareDebug.activeClipId());

  const source = await addBar(page, 'Groove source', SOURCE_START_PPQ, swung);
  const target = await addBar(page, 'Groove target', TARGET_START_PPQ, ONSETS);
  await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
    timeout: 20000,
  });

  // Arrangement clip menu: capture from the source clip, apply to the target.
  await openClipMenu(page, source.trackId, SOURCE_START_PPQ + 2);
  await page.locator('.context-menu-item[data-menu-item-id="groove-capture"]').click();
  await openClipMenu(page, target.trackId, TARGET_START_PPQ + 2);
  const applyItem = page.locator('.context-menu-item[data-menu-item-id="groove-apply"]');
  if (await applyItem.isDisabled()) fail('clip menu: apply groove stayed disabled after a capture');
  await applyItem.click();
  const expected = ONSETS.map((onset, index) => (index % 2 === 1 ? onset + SWING_PPQ : onset));
  await page.waitForFunction((id) => window.__sonareDebug.activeClipId() === id, target.clipId, {
    timeout: 5000,
  });
  const afterClipMenu = await noteStarts(page);
  if (!sameStarts(afterClipMenu, expected)) {
    fail(
      `clip menu: groove did not move the target onsets: ${JSON.stringify(afterClipMenu)}, ` +
        `expected ${JSON.stringify(expected)}`,
    );
  } else {
    console.info(`clip menu groove applied: ${JSON.stringify(afterClipMenu)}`);
  }

  // Back to the straight feel, then through the piano-roll note menu.
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(
    (straight) => {
      const starts = window.__sonareDebug
        .activeNotes()
        .map((note) => note.startPpq)
        .sort((a, b) => a - b);
      return (
        starts.length === straight.length &&
        starts.every((v, i) => Math.abs(v - straight[i]) < 0.01)
      );
    },
    ONSETS,
    { timeout: 5000 },
  );

  await page.click('.dock-tabs button:has-text("Piano Roll")');
  await page.locator('.note-grid canvas').first().waitFor({ state: 'visible', timeout: 10000 });

  // Clearing the captured feel disables the apply entry.
  const targetNotes = await page.evaluate(() => window.__sonareDebug.activeNotes());
  await openRollMenu(page, targetNotes[0]);
  await page
    .locator('.context-submenu .context-menu-item[data-menu-item-id="groove-clear"]')
    .click();
  await openRollMenu(page, targetNotes[0]);
  if (
    !(await page
      .locator('.context-submenu .context-menu-item[data-menu-item-id="groove-apply"]')
      .isDisabled())
  ) {
    fail('note menu: apply groove stayed enabled after the groove was cleared');
  }
  await page.keyboard.press('Escape');

  // Capture from the source clip's selected notes, apply to the target's.
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), source.clipId);
  const sourceNotes = await page.evaluate(() => window.__sonareDebug.activeNotes());
  await selectAllInRoll(page, sourceNotes[0]);
  await openRollMenu(page, sourceNotes[0]);
  await page
    .locator('.context-submenu .context-menu-item[data-menu-item-id="groove-capture"]')
    .click();

  await page.evaluate((id) => window.__sonareDebug.selectClip(id), target.clipId);
  const targetNow = await page.evaluate(() => window.__sonareDebug.activeNotes());
  await selectAllInRoll(page, targetNow[0]);
  await openRollMenu(page, targetNow[0]);
  const noteApply = page.locator(
    '.context-submenu .context-menu-item[data-menu-item-id="groove-apply"]',
  );
  if (await noteApply.isDisabled()) fail('note menu: apply groove stayed disabled after a capture');
  else await noteApply.click();
  const afterNoteMenu = await noteStarts(page);
  if (!sameStarts(afterNoteMenu, expected)) {
    fail(
      `note menu: groove did not move the target onsets: ${JSON.stringify(afterNoteMenu)}, ` +
        `expected ${JSON.stringify(expected)}`,
    );
  } else {
    console.info(`note menu groove applied: ${JSON.stringify(afterNoteMenu)}`);
  }

  // The source keeps its own feel: applying a groove never edits the reference.
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), source.clipId);
  if (!sameStarts(await noteStarts(page), swung)) fail('the groove source clip changed');

  await page.evaluate(
    ([ids]) => {
      for (const id of ids) window.__sonareDebug.removeTrack(id);
    },
    [[source.trackId, target.trackId]],
  );
  await page.waitForFunction(
    (count) => window.__sonareDebug.trackCount() === count,
    trackCountBefore,
    { timeout: 5000 },
  );
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), activeClipBefore);
}
