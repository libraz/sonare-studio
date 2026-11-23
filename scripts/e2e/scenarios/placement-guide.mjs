/**
 * Placement guide: the pencil's target column tints by safe/warn/ng verdict,
 * placing a clashing note thins a following accompaniment in the same undo
 * step, and the toolbar toggle turns the column off.
 *
 * Runs far past every existing clip on its own melody/backing tracks, so the
 * demo's own harmony never leaks into the fixture. Positions are located by
 * reading back the app's own state (`clipRanges()`, the piano roll's hover
 * status text) rather than assumed pixel math, so the scenario also carries
 * its own bootstrap and passes standalone under `--only=placement-guide`.
 */

import { nextPaint } from '../harness.mjs';
import * as boot from './boot.mjs';

export const name = 'placement-guide';

/** Parses an English note name (always sharps, per `formatPitch`) to a MIDI number. */
function noteNameToMidi(name) {
  const match = name.match(/^([A-G])(#)?(-?\d+)$/);
  if (!match) throw new Error(`cannot parse pitch name: ${name}`);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1]];
  const octave = Number(match[3]);
  return (octave + 1) * 12 + base + (match[2] ? 1 : 0);
}

/** Reads the piano roll's live status cell: hovered pitch name and raw ppq. */
async function readHoverStatus(page) {
  const text = (await page.locator('.cell-status').textContent()) ?? '';
  const match = text.match(/([A-G]#?-?\d+) · \d+\.\d+ · (-?[\d.]+) ppq/);
  if (!match) return null;
  return { pitchName: match[1], midi: noteNameToMidi(match[1]), ppq: Number(match[2]) };
}

/** Moves the mouse within the note-grid canvas and reads the resulting hover status. */
async function hoverGrid(page, box, x, y) {
  await page.mouse.move(box.x + x, box.y + y);
  // The floating theory card can temporarily cover a calibration point and
  // suppress its live status. Read the same coordinate projection the grid
  // uses, while still moving the real pointer for placement interactions.
  return page.evaluate(
    ({ x, y }) => {
      const grid = document.querySelector('.note-grid');
      const range = grid?.__vueParentComponent?.props.range;
      if (!range) throw new Error('piano-roll coordinate projection missing');
      return { midi: range.yToPitch(y), ppq: range.xToPpq(x) };
    },
    { x, y },
  );
}

/**
 * Seeks to `ppq` and waits for it to land, re-issuing the seek if it does
 * not: `seekPpq`'s commit is scheduled at a sample time rather than applied
 * immediately, so a seek issued while an earlier scenario's own pending
 * scheduled commit is still in flight can be overwritten by it. A second
 * seek, issued once that has had time to drain, is not racing anything.
 */
async function seekAndWait(page, ppq, matches) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.evaluate((target) => window.__sonareDebug.seekPpq(target), ppq);
    try {
      await page.waitForFunction(
        ({ target, exact }) => {
          const pos = window.__sonareDebug.positionPpq();
          return exact ? pos === target : pos >= target;
        },
        { target: ppq, exact: matches === 'exact' },
        { timeout: 2000 },
      );
      return;
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
}

/**
 * Linear-fits local x to raw hover ppq from two far-apart samples, so a target
 * ppq can be estimated without knowing the grid's zoom/scroll beforehand.
 */
async function calibrateX(page, box) {
  const xLo = box.width * 0.15;
  const xHi = box.width * 0.75;
  const yMid = box.height * 0.5;
  const lo = await hoverGrid(page, box, xLo, yMid);
  const hi = await hoverGrid(page, box, xHi, yMid);
  if (hi.ppq === lo.ppq) throw new Error('grid x calibration samples read the same ppq');
  return { xLo, ppqLo: lo.ppq, pxPerPpq: (xHi - xLo) / (hi.ppq - lo.ppq), yMid };
}

/** Nudges from the calibrated estimate until the hovered raw ppq lands in `[lo, hi)`. */
async function locateXForPpq(page, box, cal, lo, hi) {
  let x = cal.xLo + (lo - cal.ppqLo) * cal.pxPerPpq + (hi - lo) / 2;
  for (let i = 0; i < 400; i++) {
    const status = await hoverGrid(page, box, x, cal.yMid);
    if (status.ppq >= lo && status.ppq < hi) return x;
    x += status.ppq < lo ? 1 : -1;
  }
  throw new Error(`could not locate an x for raw ppq in [${lo}, ${hi})`);
}

/**
 * Locates one pitch row's exact top/bottom in local px. A two-point sample
 * gives a rowHeight-accurate first guess regardless of the piano roll's
 * current vertical scroll (an assumed default row height, or an offset from
 * a previously-found row, both broke once an earlier scenario's own tracks
 * left the roll scrolled somewhere unpredictable); if the estimate falls
 * outside the canvas, a plain wheel scrolls the roll — same as the
 * arrangement's own vertical scroll — by the shortfall and the estimate is
 * retried.
 */
async function locateRow(page, box, x, targetMidi) {
  // A few px short of the true edges: right at the bottom, the grid's
  // horizontal scrollbar strip overlaps the canvas and swallows the hover.
  const edge = 6;
  const clampY = (value) => Math.min(box.height - 1 - edge, Math.max(edge, value));
  for (let attempt = 0; attempt < 10; attempt++) {
    const yLo = edge + (box.height - 2 * edge) * 0.15;
    const yHi = edge + (box.height - 2 * edge) * 0.85;
    const lo = await hoverGrid(page, box, x, yLo);
    const hi = await hoverGrid(page, box, x, yHi);
    if (lo.midi === hi.midi) throw new Error('grid y calibration samples read the same pitch');
    // Pitch decreases as y increases.
    const rowHeight = (yHi - yLo) / (lo.midi - hi.midi);
    const estimatedY = yLo + (lo.midi - targetMidi) * rowHeight;
    if (estimatedY >= edge && estimatedY < box.height - edge) {
      let y = clampY(estimatedY);
      for (let i = 0; i < Math.ceil(rowHeight) + 5; i++) {
        const status = await hoverGrid(page, box, x, y);
        if (status.midi === targetMidi) {
          let top = y;
          while (top > edge && (await hoverGrid(page, box, x, top - 1)).midi === targetMidi) {
            top -= 1;
          }
          let bottom = y;
          while (
            bottom < box.height - 1 - edge &&
            (await hoverGrid(page, box, x, bottom + 1)).midi === targetMidi
          ) {
            bottom += 1;
          }
          return { top, bottom: bottom + 1, height: bottom + 1 - top, mid: (top + bottom + 1) / 2 };
        }
        const next = clampY(y + (status.midi > targetMidi ? 1 : -1));
        if (next === y) break;
        y = next;
      }
    }
    const deltaY =
      estimatedY < edge
        ? estimatedY - edge - rowHeight
        : estimatedY - box.height + edge + rowHeight;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, deltaY);
    await nextPaint(page);
  }
  throw new Error(`could not locate pitch ${targetMidi} within the piano roll viewport`);
}

/** Reads one overlay-canvas pixel (CSS-px coordinates, scaled to the backing store). */
async function readOverlayPixel(page, x, y, dpr) {
  return page.evaluate(
    ({ x, y, dpr }) => {
      const canvas = document.querySelectorAll('.note-grid canvas')[2];
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
      return [data[0], data[1], data[2], data[3]];
    },
    { x, y, dpr },
  );
}

/**
 * Samples a spread of points across a row's column (staying >= 3px from the
 * crosshair x and off the row's exact edges) and returns the distinct colors
 * seen, so two rows can be compared without needing to know the fill and
 * decoration colors in advance.
 */
async function sampleRowColors(page, dpr, x0, x1, row, avoidX) {
  const xs = [x0 + 3, x0 + (x1 - x0) / 2, x1 - 3].filter((x) => Math.abs(x - avoidX) >= 3);
  const ys = [row.top + 2, Math.round(row.mid), row.bottom - 2].filter(
    (y, i, all) => all.indexOf(y) === i && y >= row.top && y < row.bottom,
  );
  const colors = new Set();
  for (const x of xs) {
    for (const y of ys) {
      colors.add((await readOverlayPixel(page, x, y, dpr)).join(','));
    }
  }
  return colors;
}

/**
 * Clip-relative ppq of the test beat: beat 3 of the clip's own single bar (4/4
 * accents beats 1 and 3), not the clip's own start. Clip-relative 0 sits right
 * at the note grid's left edge, too close to the keyboard column to click
 * reliably; the auto-created clip is exactly one bar long, so an offset at or
 * past its length (e.g. 4) falls outside the audible window other tracks read
 * it through.
 */
const CELL_OFFSET_PPQ = 2;

export async function run(ctx) {
  const { page, fail } = ctx;

  const initialized = await page
    .evaluate(() => window.__sonareDebug?.initialized() === true)
    .catch(() => false);
  if (!initialized) {
    console.info('placement-guide: running standalone, bootstrapping the demo project first');
    await boot.run(ctx);
  }

  // seekPpq is a no-op until the realtime engine has started at least once;
  // a play/stop primes it without disturbing playback state for later
  // scenarios.
  if (!(await page.evaluate(() => window.__sonareDebug.engineStarted()))) {
    await page.click('.transport-bar .transport-key.play');
    await page.waitForFunction(() => window.__sonareDebug.engineStarted() === true, null, {
      timeout: 30000,
    });
    await page.click('.transport-bar .transport-key.stop');
  }

  // Build past every existing clip so the demo's own harmony cannot leak into
  // the fixture, and dropping the playhead there scrolls the arrangement to
  // reveal it.
  const maxEndPpq = await page.evaluate(() =>
    Math.max(0, ...window.__sonareDebug.clipRanges().map((c) => c.startPpq + c.lengthPpq)),
  );
  const farPpq = maxEndPpq + 32;
  await page.evaluate((ppq) => window.__sonareDebug.seekPpq(ppq), farPpq);
  await page.waitForFunction((ppq) => window.__sonareDebug.positionPpq() >= ppq, farPpq, {
    timeout: 5000,
  });

  const trackCount0 = await page.evaluate(() => window.__sonareDebug.trackCount());
  const arrangeCanvas = page.locator('.arrangement-canvas');
  await arrangeCanvas.waitFor({ state: 'visible', timeout: 10000 });

  /**
   * Scrolls the arrangement (a plain wheel over its canvas drives the shared
   * vertical scroll the track-header rows render at too) until `rowLocator`'s
   * own bounding box sits comfortably inside the canvas's, then returns that
   * box. Growing the arrangement's own height to fit every track instead —
   * however many earlier scenarios in a full run left behind — has no upper
   * bound: past a certain track count it collapses the editor dock the piano
   * roll lives in. A margin (not just "inside") avoids the row's bottom
   * edge landing on the horizontal scrollbar strip, which swallows clicks
   * the same way it swallows piano-roll hovers.
   */
  async function scrollRowIntoView(rowLocator) {
    const margin = 3;
    const fits = (containerBox, rowBox) =>
      rowBox &&
      rowBox.y >= containerBox.y + margin &&
      rowBox.y + rowBox.height <= containerBox.y + containerBox.height - margin;
    let lastY = null;
    for (let i = 0; i < 40; i++) {
      const containerBox = await arrangeCanvas.boundingBox();
      const rowBox = await rowLocator.boundingBox();
      if (fits(containerBox, rowBox)) return rowBox;
      // A wheel that moved nothing means the whole track list already fits
      // in the arrangement's current height: there is nothing left to
      // scroll, and the row (however close to the edge) is the best on offer.
      if (rowBox && rowBox.y === lastY) return rowBox;
      lastY = rowBox?.y ?? null;
      const target = rowBox
        ? rowBox.y + rowBox.height / 2
        : containerBox.y + containerBox.height + 56;
      const delta = target > containerBox.y + containerBox.height / 2 ? 60 : -60;
      await page.mouse.move(
        containerBox.x + containerBox.width / 2,
        containerBox.y + containerBox.height / 2,
      );
      await page.mouse.wheel(0, delta);
      // The arrangement canvas repaints on its own rAF-scheduled painter, one
      // frame behind the (synchronous) DOM the header row's own box is read
      // from; reading before that paint lands a click ahead of the canvas.
      await nextPaint(page);
    }
    throw new Error('could not scroll the track row into the arrangement viewport');
  }

  /** Adds a MIDI track, renames it, creates a one-bar clip far out, and returns {trackId, startPpq}. */
  async function addFarTrack(laneIndex, trackName) {
    await page.click('.track-headers .add-track');
    await page.click('.add-track-items button:has-text("MIDI track")');
    await page.waitForFunction(
      (expected) => window.__sonareDebug.trackCount() === expected,
      laneIndex + 1,
      { timeout: 5000 },
    );
    const header = page.locator('.track-headers .track-header').last();
    await header.locator('.track-name').dblclick();
    await page.locator('.track-name-input').fill(trackName);
    await page.keyboard.press('Enter');
    const trackId = await page.evaluate(() => window.__sonareDebug.activeTrackId());

    const arrangeBox = await arrangeCanvas.boundingBox();
    const headerBox = await header.boundingBox();
    const laneY = headerBox.y + headerBox.height / 2;
    const clipsBefore = await page.evaluate(() => window.__sonareDebug.clipCount());
    await page.mouse.dblclick(arrangeBox.x + arrangeBox.width * 0.3, laneY);
    await page.waitForFunction(
      (before) => window.__sonareDebug.clipCount() === before + 1,
      clipsBefore,
      { timeout: 5000 },
    );
    const startPpq = await page.evaluate(
      (id) => window.__sonareDebug.clipRanges().find((c) => c.trackId === id)?.startPpq,
      trackId,
    );
    return { trackId, startPpq };
  }

  /** Scrolls a track's header row into view and clicks its name, activating it. */
  async function activateTrackByName(trackName) {
    const header = page.locator('.track-headers .track-header', { hasText: trackName });
    await scrollRowIntoView(header);
    await header.locator('.track-name').click();
  }

  const melody = await addFarTrack(trackCount0, 'E2E Melody');
  const backing = await addFarTrack(trackCount0 + 1, 'E2E Backing');
  if (melody.startPpq !== backing.startPpq) {
    fail(
      `melody and backing clips landed on different bars: ${melody.startPpq} vs ${backing.startPpq}`,
    );
  }
  const strongBeatPpq = melody.startPpq + CELL_OFFSET_PPQ;
  console.info(`melody/backing tracks and clips created; test beat at ppq ${strongBeatPpq}`);

  // A quarter-note grid gives the placement column enough width (one bar of
  // margin at the default zoom) to sample pixels away from the crosshair.
  await page.click('.select-trigger[aria-label="Snap"]');
  await page.click('.select-list [role="option"][data-value="4"]');
  await page.click('.tool-palette button[aria-label="Draw tool"]');
  await page.click('.dock-tabs button:has-text("Piano Roll")');

  // Chord C over the same bar the accompaniment sounds it in.
  await seekAndWait(page, strongBeatPpq, 'exact');
  await page.click('.dock-tabs button:has-text("Lists")');
  await page.click('.list-tabs [data-tab-id="chords"]');
  await page.click('.list-actions button:has-text("Add at playhead")');
  await page.click('.dock-tabs button:has-text("Piano Roll")');

  // Backing is the active clip (just created); place its C4/E4/G4 triad at
  // the bar's downbeat.
  const canvas = page.locator('.note-grid canvas').first();
  await canvas.waitFor({ state: 'visible', timeout: 10000 });
  let box = await canvas.boundingBox();
  const cal = await calibrateX(page, box);
  const cellX = await locateXForPpq(page, box, cal, CELL_OFFSET_PPQ, CELL_OFFSET_PPQ + 1);

  // Each row is located right before its own click, not all three up front:
  // locating a later pitch can wheel-scroll the roll to bring it into view,
  // which would silently invalidate an earlier pitch's already-measured
  // (now stale) row position.
  const backingCountBefore = await page.evaluate(() => window.__sonareDebug.noteCount());
  for (const targetMidi of [60, 64, 67]) {
    const row = await locateRow(page, box, cellX, targetMidi);
    const before = await page.evaluate(() => window.__sonareDebug.noteCount());
    // A plain click, not a double-click: the draw tool places a note on a
    // single click (double-clicking it fires two draw gestures).
    await page.mouse.click(box.x + cellX, box.y + row.mid);
    await page.waitForFunction((n) => window.__sonareDebug.noteCount() === n, before + 1, {
      timeout: 5000,
    });
  }
  console.info(`backing triad placed: ${backingCountBefore} -> ${backingCountBefore + 3} notes`);

  // Follow melody, via the backing track header's context menu.
  const backingHeader = page.locator('.track-headers .track-header', { hasText: 'E2E Backing' });
  await scrollRowIntoView(backingHeader);
  await backingHeader.click({ button: 'right' });
  await page.click('.context-menu-item[data-menu-item-id="lead-follow"]');
  await page.locator('.context-submenu .context-menu-item', { hasText: 'E2E Melody' }).click();
  await page.locator('.context-submenu').waitFor({ state: 'hidden' });

  // Switch to the melody clip; the shared TimelineRange keeps its horizontal
  // zoom/scroll, so the calibrated x is still valid.
  await activateTrackByName('E2E Melody');
  box = await canvas.boundingBox();
  // F4 is hovered (and read back) before G4 is even located: locating G4 can
  // wheel-scroll the roll, which would silently invalidate F4's row if it
  // were measured first and used only afterwards.
  const f4 = await locateRow(page, box, cellX, 65);
  await page.mouse.move(box.x + cellX, box.y + f4.mid);
  await nextPaint(page);
  const f4Status = await readHoverStatus(page);
  const g4Melody = await locateRow(page, box, cellX, 67);
  await page.mouse.move(box.x + cellX, box.y + g4Melody.mid);
  await nextPaint(page);
  const g4Status = await readHoverStatus(page);
  console.info(
    `hovered F4 (${f4Status?.pitchName}) and G4 (${g4Status?.pitchName}) on the placement column`,
  );
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  const x0 = cal.xLo + (CELL_OFFSET_PPQ - cal.ppqLo) * cal.pxPerPpq;
  const x1 = cal.xLo + (CELL_OFFSET_PPQ + 1 - cal.ppqLo) * cal.pxPerPpq;
  const f4Colors = await sampleRowColors(page, dpr, x0, x1, f4, cellX);
  const g4Colors = await sampleRowColors(page, dpr, x0, x1, g4Melody, cellX);
  const sameColors = f4Colors.size === g4Colors.size && [...f4Colors].every((c) => g4Colors.has(c));
  if (sameColors) {
    fail(`F4 and G4 placement rows painted the same colors: ${[...f4Colors].join(' | ')}`);
  } else {
    console.info(
      `F4 row colors {${[...f4Colors].join(' | ')}} differ from G4 row colors {${[...g4Colors].join(' | ')}}`,
    );
  }

  // Click F4 in: the melody note count goes up by one, and thinning the
  // clashing backing E4 should drop it by one in the same history step.
  // Re-locate first: locating G4 above could have wheel-scrolled the roll,
  // silently invalidating the row measured for F4 earlier.
  const f4Reclick = await locateRow(page, box, cellX, 65);
  const melodyCountBefore = await page.evaluate(() => window.__sonareDebug.noteCount());
  await page.mouse.click(box.x + cellX, box.y + f4Reclick.mid);
  await page.waitForFunction((n) => window.__sonareDebug.noteCount() === n, melodyCountBefore + 1, {
    timeout: 5000,
  });
  console.info(`F4 placed on the melody: ${melodyCountBefore} -> ${melodyCountBefore + 1} notes`);

  await activateTrackByName('E2E Backing');
  const backingAfterClick = await page.evaluate(() => window.__sonareDebug.noteCount());
  if (backingAfterClick !== backingCountBefore + 3 - 1) {
    fail(
      `backing note count after placing F4: expected ${backingCountBefore + 2}, got ${backingAfterClick}`,
    );
  } else {
    console.info(`backing E4 thinned: ${backingCountBefore + 3} -> ${backingAfterClick} notes`);
  }

  // Undo restores both the melody's F4 and the backing's thinned E4 in the
  // same step.
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(
    (n) => window.__sonareDebug.noteCount() === n,
    backingCountBefore + 3,
    { timeout: 5000 },
  );
  console.info(`undo restored the backing triad: -> ${backingCountBefore + 3} notes`);
  await activateTrackByName('E2E Melody');
  await page.waitForFunction((n) => window.__sonareDebug.noteCount() === n, melodyCountBefore, {
    timeout: 5000,
  });
  console.info(`undo restored the melody: -> ${melodyCountBefore} notes`);

  // Turning the placement-guide toggle off removes the column. Re-locate G4
  // (the roll may have wheel-scrolled since it was first found) and hover
  // well clear of its row so the crosshair guide line — still drawn
  // regardless of the toggle — cannot land in a sampled pixel.
  await togglePlacementGuide(page);
  box = await canvas.boundingBox();
  const g4MelodyRecheck = await locateRow(page, box, cellX, 67);
  const awayY =
    g4MelodyRecheck.top - 20 >= 0 ? g4MelodyRecheck.top - 20 : g4MelodyRecheck.bottom + 20;
  await page.mouse.move(box.x + cellX, box.y + awayY);
  await nextPaint(page);
  const afterToggleColors = await sampleRowColors(page, dpr, x0, x1, g4MelodyRecheck, cellX);
  const stillTinted = [...afterToggleColors].some((c) => g4Colors.has(c) && c !== '0,0,0,0');
  if (stillTinted) {
    fail(
      `placement column still painted after disabling the toggle: {${[...afterToggleColors].join(' | ')}}`,
    );
  } else {
    console.info('placement column cleared once the toolbar toggle is off');
  }

  // Leave the shared editor state as found.
  await togglePlacementGuide(page);
  await page.click('.select-trigger[aria-label="Snap"]');
  await page.click('.select-list [role="option"][data-value="16"]');
  await page.click('.tool-palette button[aria-label="Select tool"]');
  await page.evaluate(() => window.__sonareDebug.seekPpq(0));
  // Scroll the arrangement's track lanes back to the top: later scenarios
  // read a lane's pixels by a fixed "28 + index * 56" offset from the
  // canvas's own top edge, which only holds with no vertical scroll.
  const finalArrangeBox = await arrangeCanvas.boundingBox();
  await page.mouse.move(
    finalArrangeBox.x + finalArrangeBox.width / 2,
    finalArrangeBox.y + finalArrangeBox.height / 2,
  );
  await page.mouse.wheel(0, -100000);
}

/** Flips the Placement toggle, which lives in the piano-roll toolbar's View popover. */
async function togglePlacementGuide(page) {
  await page.click('.roll-toolbar .tb-menu:has-text("View")');
  await page.click('.view-popover .toggle-pill:has-text("Placement")');
  await page.click('.roll-toolbar .tb-menu:has-text("View")');
  await page.locator('.view-popover').waitFor({ state: 'hidden' });
}
