import { openFreshPage, skipTour } from '../fresh-page.mjs';
import { untilDoneAcceptingConfirms } from '../harness.mjs';

/**
 * Fast project switching: a MIDI file with three parts is imported and, while
 * its engine sync is still pending, a one-part file replaces it through
 * File > Import MIDI. Once the app reports no engine sync pending, the engine
 * holds the second project's clips only, so no sync of the first project
 * landed after the second.
 */
export const name = 'project-switch-sync';

let sonare = null;
async function libsonare() {
  if (!sonare) {
    sonare = await import('@libraz/libsonare');
    await sonare.init();
  }
  return sonare;
}

/** A Standard MIDI File with one note on each of the given channels. */
async function smfWithChannels(channels) {
  const { Project } = await libsonare();
  const project = new Project();
  try {
    const { clipId } = project.addMidiClip(0, 4);
    project.setMidiEvents(
      clipId,
      channels.flatMap((channel) => [
        { ppq: 0, word0: (0x2 << 28) | (0x9 << 20) | (channel << 16) | (60 << 8) | 100 },
        { ppq: 1, word0: (0x2 << 28) | (0x8 << 20) | (channel << 16) | (60 << 8) },
      ]),
    );
    return Buffer.from(project.exportSmf());
  } finally {
    project.destroy();
  }
}

const engineState = (page) =>
  page.evaluate(() => ({
    tracks: window.__sonareDebug.trackCount(),
    engineMidiClips: window.__sonareDebug.engineMidiClipCount(),
    documentMidiClips: window.__sonareDebug
      .projectDocument()
      .tracks.flatMap((track) => track.clips.filter((clip) => (clip.notes ?? []).length > 0))
      .length,
  }));

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const first = await smfWithChannels([0, 1, 2]);
  const second = await smfWithChannels([0]);
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await page.goto(baseUrl, { waitUntil: 'load' });
    const start = page.locator('[data-testid="start-import-midi"]');
    await start.waitFor({ state: 'visible', timeout: 30000 });
    const firstChooser = page.waitForEvent('filechooser');
    await start.click();
    await (await firstChooser).setFiles({
      name: 'three-parts.mid',
      mimeType: 'audio/midi',
      buffer: first,
    });
    await page.waitForFunction(() => window.__sonareDebug?.trackCount() === 3, null, {
      timeout: 30000,
    });
    await skipTour(page);
    await page.click('.transport-bar .transport-key.play');
    await page.waitForFunction(
      () => window.__sonareDebug.engineStarted() || window.__sonareDebug.lastError() !== '',
      null,
      { timeout: 30000 },
    );
    await page.click('.transport-bar .transport-key.stop');
    await page.evaluate(() => window.__sonareDebug.whenEngineSyncIdle());
    const before = await engineState(page);
    if (before.engineMidiClips !== before.documentMidiClips || before.engineMidiClips < 3) {
      fail(`the three-part project did not reach the engine: ${JSON.stringify(before)}`);
      return;
    }

    // Edit the first project so a debounced sync is pending, then replace it at once.
    const edited = await page.evaluate(() => {
      const debug = window.__sonareDebug;
      const notes = debug.noteCount();
      debug.addNoteAt(72, 2, 1);
      return debug.noteCount() > notes;
    });
    if (!edited) {
      fail('could not add a note to the first project before replacing it');
      return;
    }
    await page.click('.app-menubar__trigger:has-text("File")');
    const secondChooser = page.waitForEvent('filechooser');
    await page
      .locator('.menu-panel [role="menuitem"]')
      .filter({ hasText: /^Import MIDI\.\.\.$/ })
      .click();
    await (await secondChooser).setFiles({
      name: 'one-part.mid',
      mimeType: 'audio/midi',
      buffer: second,
    });
    await untilDoneAcceptingConfirms(
      page,
      async () => page.evaluate(() => window.__sonareDebug.trackCount() === 1),
      30000,
    );
    await page.evaluate(() => window.__sonareDebug.whenEngineSyncIdle());
    const after = await engineState(page);
    if (after.documentMidiClips !== 1 || after.engineMidiClips !== after.documentMidiClips) {
      fail(
        `after replacing the project the engine holds ${after.engineMidiClips} MIDI clip(s) ` +
          `for a document with ${after.documentMidiClips}: ${JSON.stringify({ before, after })}`,
      );
      return;
    }
    console.info(
      `project switch: engine MIDI clips ${before.engineMidiClips} -> ${after.engineMidiClips}, ` +
        'matching the replacing document',
    );
  } finally {
    await context.close();
  }
}
