/** Save the generated pop project under a named slot, reopen it, and edit it. */
export const name = 'project-save-reopen';

const PROJECT_NAME = 'e2e-pop-save-reopen';
const PROBE_RANGE = { startPpq: 0, endPpq: 8 };

/**
 * Returns the user-visible document shape while dropping editor-generated ids.
 * Track ids and note ids are intentionally not part of a saved project's
 * identity: both are allocated again while a document is reopened.
 */
async function semanticState(page) {
  return page.evaluate(() => {
    const debug = window.__sonareDebug;
    const trackIds = debug.trackIds();
    const clips = debug
      .clipRanges()
      .map(({ id: _id, trackId, ...clip }) => ({
        ...clip,
        trackIndex: trackIds.indexOf(trackId),
      }))
      .sort(
        (left, right) =>
          left.trackIndex - right.trackIndex ||
          left.startPpq - right.startPpq ||
          left.lengthPpq - right.lengthPpq ||
          left.kind.localeCompare(right.kind),
      );
    const notes = debug
      .activeNotes()
      .map(({ id: _id, ...note }) => note)
      .sort(
        (left, right) =>
          left.startPpq - right.startPpq ||
          left.pitch - right.pitch ||
          left.durationPpq - right.durationPpq ||
          left.channel - right.channel,
      );
    const chords = debug
      .chordRanges()
      .map((chord) => ({ ...chord }))
      .sort((left, right) => left.startPpq - right.startPpq || left.endPpq - right.endPpq);
    return {
      chords,
      clips,
      instruments: debug.trackInstruments(),
      notes,
      noteCount: debug.noteCount(),
      trackCount: debug.trackCount(),
    };
  });
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Finds the generated Lead track and its bar-one clip. */
async function leadClipInfo(page) {
  return page.evaluate(() => {
    const headers = [...document.querySelectorAll('.track-header .track-name')].map((node) =>
      (node.textContent ?? '').trim(),
    );
    const trackIndex = headers.indexOf('Lead');
    if (trackIndex < 0) throw new Error(`Lead track is missing: ${headers.join(', ')}`);
    const trackId = window.__sonareDebug.trackIds()[trackIndex];
    const clip = window.__sonareDebug
      .clipRanges()
      .find((entry) => entry.trackId === trackId && entry.startPpq === 0);
    if (!clip) throw new Error('Lead bar-one clip is missing');
    return { clip, trackIndex };
  });
}

/** Selects a timeline clip by its semantic PPQ position and named lane. */
async function selectLeadClip(page, clip) {
  const header = page
    .locator('.track-header')
    .filter({ has: page.locator('.track-name:text-is("Lead")') })
    .first();
  await header.waitFor({ state: 'visible' });
  const canvas = page.locator('.arrangement-canvas canvas').first();
  const box = await canvas.boundingBox();
  const headerBox = await header.boundingBox();
  if (!box || !headerBox) throw new Error('arrangement lane is not measurable');

  const point = await page.evaluate(
    ({ ppq, y }) => {
      const arrangement = document.querySelector('.arrangement-canvas');
      const range = arrangement?.__vueParentComponent?.props.range;
      if (!arrangement || !range) throw new Error('arrangement range is missing');
      const rect = arrangement.getBoundingClientRect();
      return { x: rect.left + range.ppqToX(ppq), y };
    },
    { ppq: clip.startPpq + Math.min(clip.lengthPpq / 2, 1), y: headerBox.y + headerBox.height / 2 },
  );
  if (point.x < box.x || point.x > box.x + box.width) {
    throw new Error(`Lead clip is outside the visible arrangement: ${JSON.stringify(point)}`);
  }
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction((id) => window.__sonareDebug.activeClipId() === id, clip.id);
}

/** Draws one note into an empty cell in the reopened Lead clip. */
async function drawOneLeadNote(page) {
  await page.click('.dock-tabs button:has-text("Piano Roll")');
  await page.locator('.note-grid canvas').first().waitFor({ state: 'visible' });
  await page.locator('.tool-palette .tool-button').nth(1).click();

  const point = await page.evaluate(() => {
    const grid = document.querySelector('.note-grid');
    const props = grid?.__vueParentComponent?.props;
    if (!grid || !props?.range) throw new Error('reopened Lead piano roll is missing');
    const rect = grid.getBoundingClientRect();
    const notes = props.notes ?? [];
    // Try later cells first so the generated melody's opening phrase remains
    // untouched. The range is clip-local because the selected clip starts at 0.
    for (const ppq of [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]) {
      for (const pitch of [48, 50, 52, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72, 74, 76]) {
        const occupied = notes.some(
          (note) =>
            note.pitch === pitch && note.startPpq <= ppq && ppq < note.startPpq + note.durationPpq,
        );
        const x = props.range.ppqToX(ppq);
        const y = props.range.pitchToY(pitch) + props.range.rowHeight / 2;
        if (!occupied && x >= 12 && x <= rect.width - 12 && y >= 10 && y <= rect.height - 10) {
          return { x: rect.left + x, y: rect.top + y, ppq, pitch };
        }
      }
    }
    throw new Error('no empty Lead piano-roll cell was available for the reopen edit');
  });

  const before = await page.evaluate(() => window.__sonareDebug.activeNotes().length);
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(
    (count) => window.__sonareDebug.activeNotes().length === count + 1,
    before,
  );
  return point;
}

export async function run({ page, fail }) {
  // Select Lead before taking the snapshot. pop-audio-adjust leaves the audio
  // clip focused, so the active-note debug view would otherwise be empty.
  const leadBeforeSave = await leadClipInfo(page);
  await selectLeadClip(page, leadBeforeSave.clip);
  const before = await semanticState(page);
  if (before.trackCount < 5 || before.chords.length < 8 || before.notes.length === 0) {
    fail(`generated pop project is incomplete before Save As: ${JSON.stringify(before)}`);
  }
  const audioBefore = before.clips.filter((clip) => clip.kind === 'audio');
  if (audioBefore.length === 0)
    fail('generated pop project has no reference audio clip before Save As');

  const exportBefore = await page.evaluate(
    (range) => window.__sonareDebug.exportProbe(false, range),
    PROBE_RANGE,
  );
  if (exportBefore.riff !== 'RIFF' || exportBefore.totalFrames <= 0) {
    fail(`short export before Save As was invalid: ${JSON.stringify(exportBefore)}`);
  }

  // Save As is deliberately driven through the File menu so the named slot,
  // rather than the crash-recovery autosave slot, is what the next open uses.
  await page.click('.app-menubar__trigger:has-text("File")');
  await page.locator('[id="menubar-file-file_2e_saveAs"]').click();
  const prompt = page.locator('.modal-card:has(.dialog-input)');
  await prompt.waitFor({ state: 'visible' });
  await prompt.locator('.dialog-input').fill(PROJECT_NAME);
  await prompt.locator('.modal-foot button.primary').click();
  await page.waitForSelector('.dirty-dot', { state: 'detached', timeout: 20000 });
  await page.waitForFunction((name) => window.__sonareDebug.projectName() === name, PROJECT_NAME, {
    timeout: 20000,
  });
  console.info(`saved generated pop project as ${PROJECT_NAME}`);

  await page.reload({ waitUntil: 'load' });
  await page.locator('[data-testid="start-new"]').waitFor({ state: 'visible', timeout: 30000 });
  const savedProject = page.locator('.ss-project').filter({ hasText: PROJECT_NAME }).first();
  await savedProject.waitFor({ state: 'visible', timeout: 30000 });
  if (!(await page.locator('[data-testid="start-continue"]').isVisible())) {
    fail('reload did not expose the autosave recovery choice alongside the named project');
  }
  // Click the named row directly. This guards against accidentally testing the
  // autosave Continue path, which has different slot/revision semantics.
  await savedProject.click();
  try {
    await page.waitForFunction(
      ({ name, tracks }) =>
        window.__sonareDebug?.initialized() === true &&
        window.__sonareDebug.projectName() === name &&
        window.__sonareDebug.trackCount() === tracks,
      { name: PROJECT_NAME, tracks: before.trackCount },
      { timeout: 30000 },
    );
  } catch (error) {
    const actual = await page.evaluate(() => ({
      initialized: window.__sonareDebug?.initialized(),
      projectName: window.__sonareDebug?.projectName(),
      trackCount: window.__sonareDebug?.trackCount(),
      bodyText: document.body.innerText.slice(-600),
    }));
    throw new Error(
      `named project did not reopen: ${JSON.stringify({ expectedTracks: before.trackCount, actual })}`,
      { cause: error },
    );
  }
  await page.locator('.modal-scrim.is-launcher-layer').waitFor({ state: 'detached' });

  // Loading a named project must start with a fresh command history. The menu
  // state is the public UI signal that no pre-open edits are still undoable.
  await page.click('#menubar-trigger-edit');
  const undo = page.locator('[id="menubar-edit-edit_2e_undo"]');
  if (!(await undo.isDisabled()))
    fail('named-project open retained an Undo entry from before reload');
  await page.keyboard.press('Escape');

  const afterOpen = await semanticState(page);
  if (!sameJson(afterOpen.chords, before.chords)) {
    fail(
      `chord progression changed after named-project open: ${JSON.stringify({ before: before.chords, after: afterOpen.chords })}`,
    );
  }
  if (!sameJson(afterOpen.clips, before.clips)) {
    fail(
      `clip geometry changed after named-project open: ${JSON.stringify({ before: before.clips, after: afterOpen.clips })}`,
    );
  }
  if (!sameJson(afterOpen.instruments, before.instruments)) {
    fail(
      `track instruments changed after named-project open: ${JSON.stringify({ before: before.instruments, after: afterOpen.instruments })}`,
    );
  }
  const audioAfter = afterOpen.clips.filter((clip) => clip.kind === 'audio');
  if (!sameJson(audioAfter, audioBefore)) {
    fail(
      `reference audio clip geometry was not restored: ${JSON.stringify({ before: audioBefore, after: audioAfter })}`,
    );
  }

  const exportAfter = await page.evaluate(
    (range) => window.__sonareDebug.exportProbe(false, range),
    PROBE_RANGE,
  );
  if (
    exportAfter.riff !== 'RIFF' ||
    exportAfter.totalFrames <= 0 ||
    exportAfter.hash !== exportBefore.hash
  ) {
    fail(
      `reference audio or MIDI content changed after reopen: ${JSON.stringify({ before: exportBefore, after: exportAfter })}`,
    );
  } else {
    console.info(
      `named-project reopen preserved ${afterOpen.clips.length} clips and audio export ${exportAfter.hash}`,
    );
  }

  const leadAfterOpen = await leadClipInfo(page);
  await selectLeadClip(page, leadAfterOpen.clip);
  const leadNotesAfterOpen = await semanticState(page);
  if (!sameJson(leadNotesAfterOpen.notes, before.notes)) {
    fail(
      `Lead notes changed after named-project open: ${JSON.stringify({ before: before.notes, after: leadNotesAfterOpen.notes })}`,
    );
  }

  const editPoint = await drawOneLeadNote(page);
  const afterEdit = await semanticState(page);
  if (afterEdit.notes.length !== before.notes.length + 1) {
    fail(`reopened Lead note edit did not add exactly one note at ${JSON.stringify(editPoint)}`);
  }
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(
    (expected) => window.__sonareDebug.activeNotes().length === expected,
    before.notes.length,
  );
  const afterUndo = await semanticState(page);
  if (!sameJson(afterUndo.notes, before.notes)) {
    fail(
      `Undo did not restore the saved Lead notes: ${JSON.stringify({ before: before.notes, after: afterUndo.notes })}`,
    );
  } else {
    console.info('reopened Lead note edited and restored with Undo');
  }
}
