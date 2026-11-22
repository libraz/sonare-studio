/** Save, cancel, restore and commit a named project revision in a clean context. */
export const name = 'project-revisions';

const PROJECT_NAME = 'e2e-named-revisions';
const REVISION_LABEL = 'baseline';

const ascii = (value) => [...value].map((character) => character.charCodeAt(0));

function u16(value) {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function vlq(value) {
  const bytes = [value & 0x7f];
  for (let rest = value >>> 7; rest > 0; rest >>>= 7) {
    bytes.unshift((rest & 0x7f) | 0x80);
  }
  return bytes;
}

function chunk(id, bytes) {
  return [...ascii(id), ...u32(bytes.length), ...bytes];
}

function midiBytes() {
  const title = 'Revision Lead';
  const track = [
    0,
    0xff,
    0x03,
    title.length,
    ...ascii(title),
    0,
    0x90,
    60,
    100,
    ...vlq(480),
    0x80,
    60,
    0,
    0,
    0x90,
    67,
    100,
    ...vlq(480),
    0x80,
    67,
    0,
    0,
    0xff,
    0x2f,
    0,
  ];
  return Buffer.from([
    ...chunk('MThd', [...u16(0), ...u16(1), ...u16(480)]),
    ...chunk('MTrk', track),
  ]);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function freshPage(page) {
  const browser = page.context().browser();
  if (!browser) throw new Error('the E2E page has no browser owner');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  return { context, page: await context.newPage() };
}

async function skipTour(page) {
  if ((await page.evaluate(() => localStorage.getItem('sonare-studio.tourSeen'))) !== '1') {
    const tour = page.locator('.tour-tooltip');
    await tour.waitFor({ state: 'visible', timeout: 15000 });
    await tour.locator('.tour-skip').click();
    await page.locator('.tour-overlay').waitFor({ state: 'detached', timeout: 10000 });
  }
  await page.locator('.modal-scrim.is-launcher-layer').waitFor({
    state: 'detached',
    timeout: 15000,
  });
}

async function importMidi(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.locator('[data-testid="start-import-midi"]').waitFor({ state: 'visible' });
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('[data-testid="start-import-midi"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'revision-midi.mid',
    mimeType: 'audio/midi',
    buffer: midiBytes(),
  });
  await page.waitForFunction(
    () => window.__sonareDebug?.initialized() === true && window.__sonareDebug.trackCount() > 0,
    null,
    { timeout: 30000 },
  );
  await skipTour(page);
}

async function semanticState(page) {
  return page.evaluate(() => {
    const document = window.__sonareDebug.projectDocument();
    return {
      tracks: document.tracks.map((track) => ({
        name: track.name,
        kind: track.kind,
        instrument: track.instrument ?? null,
        clips: track.clips.map((clip) => ({
          name: clip.name,
          kind: clip.kind ?? 'midi',
          startPpq: clip.startPpq,
          lengthPpq: clip.lengthPpq,
          sourceOffsetPpq: clip.sourceOffsetPpq,
          gain: clip.gain,
          loopEnabled: clip.loopEnabled,
          loopLengthPpq: clip.loopLengthPpq,
          notes: clip.notes.map((note) => ({
            pitch: note.pitch,
            velocity: note.velocity,
            startPpq: note.startPpq,
            durationPpq: note.durationPpq,
            channel: note.channel,
            ...(note.offVelocity === undefined ? {} : { offVelocity: note.offVelocity }),
          })),
        })),
      })),
    };
  });
}

async function editOneNote(page) {
  const midiClipId = await page.evaluate(() => window.__sonareDebug.midiClipIds()[0]);
  if (midiClipId === undefined) throw new Error('revision project has no MIDI clip');
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), midiClipId);
  await page.click('.dock-tabs button:has-text("Piano Roll")');
  await page.locator('.note-grid canvas').first().waitFor({ state: 'visible' });
  await page.locator('.tool-palette .tool-button').nth(1).click();
  const point = await page.evaluate(() => {
    const grid = document.querySelector('.note-grid');
    const props = grid?.__vueParentComponent?.props;
    if (!grid || !props?.range) throw new Error('revision MIDI piano roll is unavailable');
    const rect = grid.getBoundingClientRect();
    const notes = props.notes ?? [];
    for (const ppq of [3.5, 3, 2.5, 2, 1.5, 1, 0.5]) {
      for (const pitch of [48, 50, 52, 55, 57, 59, 62, 65, 67, 69, 71, 72]) {
        const occupied = notes.some(
          (note) =>
            note.pitch === pitch && note.startPpq <= ppq && ppq < note.startPpq + note.durationPpq,
        );
        const x = props.range.ppqToX(ppq);
        const y = props.range.pitchToY(pitch) + props.range.rowHeight / 2;
        if (!occupied && x >= 12 && x <= rect.width - 12 && y >= 10 && y <= rect.height - 10) {
          return { x: rect.left + x, y: rect.top + y };
        }
      }
    }
    throw new Error('revision MIDI clip has no drawable empty cell');
  });
  const before = await page.evaluate(() => window.__sonareDebug.activeNotes().length);
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(
    (count) => window.__sonareDebug.activeNotes().length === count + 1,
    before,
    { timeout: 15000 },
  );
  return before;
}

async function openFileMenu(page) {
  await page.click('.app-menubar__trigger:has-text("File")');
}

async function openRevisions(page) {
  await openFileMenu(page);
  await page.locator('[id="menubar-file-file_2e_revisions"]').click();
  await page.locator('.modal-card:has(.stored-list)').waitFor({ state: 'visible' });
}

async function saveAs(page) {
  await openFileMenu(page);
  await page.locator('[id="menubar-file-file_2e_saveAs"]').click();
  const prompt = page.locator('.modal-card:has(.dialog-input)');
  await prompt.waitFor({ state: 'visible' });
  await prompt.locator('.dialog-input').fill(PROJECT_NAME);
  await prompt.locator('.modal-foot button.primary').click();
  await page.locator('.dirty-dot').waitFor({ state: 'detached', timeout: 20000 });
  await page.waitForFunction((name) => window.__sonareDebug.projectName() === name, PROJECT_NAME, {
    timeout: 20000,
  });
}

async function saveCurrentRevision(page) {
  await openRevisions(page);
  await page
    .locator('.modal-card:has(.stored-list) button')
    .filter({ hasText: 'Save current' })
    .click();
  const prompt = page.locator('.modal-card:has(.dialog-input)');
  await prompt.waitFor({ state: 'visible' });
  await prompt.locator('.dialog-input').fill(REVISION_LABEL);
  await prompt.locator('.modal-foot button.primary').click();
  await page
    .locator('.modal-card:has(.stored-list) .stored-load')
    .filter({ hasText: REVISION_LABEL })
    .waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('.modal-card:has(.stored-list) button').filter({ hasText: 'Close' }).click();
}

async function restoreWith(page, confirmLabel) {
  await openRevisions(page);
  await page
    .locator('.modal-card:has(.stored-list) .stored-load')
    .filter({ hasText: REVISION_LABEL })
    .click();
  const prompt = page.locator('.modal-card:has(.dialog-message)');
  await prompt.waitFor({ state: 'visible' });
  await prompt.locator('.modal-foot button').filter({ hasText: confirmLabel }).click();
  return prompt;
}

async function saveCurrentProject(page) {
  await openFileMenu(page);
  await page.locator('[id="menubar-file-file_2e_save"]').click();
  await page.locator('.dirty-dot').waitFor({ state: 'detached', timeout: 30000 });
}

async function reopenNamedProject(page, baseUrl) {
  await page.reload({ waitUntil: 'load' });
  await page.locator('[data-testid="start-new"]').waitFor({ state: 'visible', timeout: 30000 });
  const savedProject = page.locator('.ss-project').filter({ hasText: PROJECT_NAME }).first();
  await savedProject.waitFor({ state: 'visible', timeout: 30000 });
  await savedProject.click();
  await page.waitForFunction(
    (name) =>
      window.__sonareDebug?.initialized() === true && window.__sonareDebug.projectName() === name,
    PROJECT_NAME,
    { timeout: 30000 },
  );
  await page.locator('.modal-scrim.is-launcher-layer').waitFor({ state: 'detached' });
  await skipTour(page);
  void baseUrl;
}

export async function run({ page, baseUrl, fail }) {
  const isolated = await freshPage(page);
  try {
    await importMidi(isolated.page, baseUrl);
    await saveAs(isolated.page);
    const baseline = await semanticState(isolated.page);
    await saveCurrentRevision(isolated.page);

    await editOneNote(isolated.page);
    const edited = await semanticState(isolated.page);
    if (sameJson(edited, baseline)) {
      fail(`revision mutation did not change the project: ${JSON.stringify(baseline)}`);
    }

    const cancelPrompt = await restoreWith(isolated.page, 'Cancel');
    await cancelPrompt.waitFor({ state: 'detached' });
    const afterCancel = await semanticState(isolated.page);
    if (!sameJson(afterCancel, edited)) {
      fail(
        `cancelling revision restore changed the edited project: ${JSON.stringify({ edited, afterCancel })}`,
      );
    } else {
      console.info('revision restore Cancel kept the edited document');
    }
    await isolated.page
      .locator('.modal-card:has(.stored-list) button')
      .filter({ hasText: 'Close' })
      .click();

    await restoreWith(isolated.page, 'Discard');
    await isolated.page.waitForFunction(
      ({ trackCount, noteCount }) =>
        window.__sonareDebug.initialized() &&
        window.__sonareDebug.trackCount() === trackCount &&
        window.__sonareDebug
          .projectDocument()
          .tracks.reduce(
            (count, track) => count + track.clips.reduce((sum, clip) => sum + clip.notes.length, 0),
            0,
          ) === noteCount &&
        !window.__sonareDebug.applyPending(),
      {
        trackCount: baseline.tracks.length,
        noteCount: baseline.tracks.reduce(
          (count, track) => count + track.clips.reduce((sum, clip) => sum + clip.notes.length, 0),
          0,
        ),
      },
      { timeout: 30000 },
    );
    const restored = await semanticState(isolated.page);
    if (!sameJson(restored, baseline)) {
      fail(
        `revision restore did not match the baseline: ${JSON.stringify({ baseline, restored })}`,
      );
    }
    if (!(await isolated.page.locator('.dirty-dot').isVisible())) {
      fail('revision restore did not leave the named project dirty');
    }
    for (const action of ['undo', 'redo']) {
      if (!(await isolated.page.locator(`button.${action}-toggle`).isDisabled())) {
        fail(`revision restore left the header ${action} button enabled`);
      }
    }
    await isolated.page.locator('#menubar-trigger-edit').click();
    const undo = isolated.page.locator('[id="menubar-edit-edit_2e_undo"]');
    if (!(await undo.isDisabled())) {
      const undoState = await isolated.page.evaluate(() => ({
        matches: [...document.querySelectorAll('[id="menubar-edit-edit_2e_undo"]')].map(
          (element) => ({
            text: (element.textContent ?? '').trim(),
            disabled: element.getAttribute('aria-disabled'),
            hidden: element.getAttribute('hidden') !== null,
            display: getComputedStyle(element).display,
            parent: element.parentElement?.className ?? null,
          }),
        ),
        editMenu: document.querySelector('#menubar-trigger-edit')?.getAttribute('aria-expanded'),
      }));
      fail(
        `revision restore retained an Undo entry from the pre-restore edit: ${JSON.stringify(undoState)}`,
      );
    }
    await isolated.page.keyboard.press('Escape');
    console.info(
      `revision restored baseline with ${restored.tracks.length} track(s); dirty and Undo reset verified`,
    );

    await saveCurrentProject(isolated.page);
    await reopenNamedProject(isolated.page, baseUrl);
    const reloaded = await semanticState(isolated.page);
    if (!sameJson(reloaded, baseline)) {
      fail(
        `saved restored revision did not persist after reload: ${JSON.stringify({ baseline, reloaded })}`,
      );
    } else {
      console.info(`saved restored revision reloaded with ${reloaded.tracks.length} track(s)`);
    }
  } finally {
    await isolated.context.close();
  }
}
