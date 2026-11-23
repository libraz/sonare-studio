import { openFreshPage, skipTour } from '../fresh-page.mjs';
import { untilDoneAcceptingConfirms } from '../harness.mjs';

/**
 * MIDI 2.0 clip file import: a clip file holding a 16-bit note-on velocity that
 * no 7-bit value scales to is opened from the start screen, and the events the
 * engine read from it carry that velocity exactly. The same clip saved as a
 * Standard MIDI File and opened through File > Import MIDI comes back as a
 * 7-bit velocity, so the check can tell the two readers apart. The claim stops
 * at the engine: the project document stores the note at its 7-bit velocity.
 */
export const name = 'midi2-clip-import';

/** 0x1234 >> 9 is 9, and 9 widens to 0x1200: no 7-bit velocity reaches it. */
const VELOCITY_16 = 0x1234;
const NOTE = 60;

let sonare = null;
async function libsonare() {
  if (!sonare) {
    sonare = await import('@libraz/libsonare');
    await sonare.init();
  }
  return sonare;
}

/** One note with a MIDI 2.0 velocity, written as a clip file and as an SMF. */
async function sourceFiles() {
  const { Project } = await libsonare();
  const project = new Project();
  try {
    const { clipId } = project.addMidiClip(0, 4);
    project.setMidiEvents(clipId, [
      { ppq: 0, word0: (0x4 << 28) | (0x9 << 20) | (NOTE << 8), word1: (VELOCITY_16 << 16) >>> 0 },
      { ppq: 1, word0: (0x4 << 28) | (0x8 << 20) | (NOTE << 8), word1: 0 },
    ]);
    return {
      clip: Buffer.from(project.exportClipFile()),
      smf: Buffer.from(project.exportSmf()),
    };
  } finally {
    project.destroy();
  }
}

/** The note-on the last MIDI import read, as message type and velocity word. */
const importedNoteOn = (page) =>
  page.evaluate((note) => {
    const events = Object.values(window.__sonareDebug.lastMidiImportEvents() ?? {}).flat();
    const noteOn = events.find(
      (event) => ((event.word0 >>> 20) & 0xf) === 0x9 && ((event.word0 >>> 8) & 0x7f) === note,
    );
    if (!noteOn) return null;
    const type = noteOn.word0 >>> 28;
    return {
      type,
      velocity: type === 0x4 ? noteOn.word1 >>> 16 : noteOn.word0 & 0x7f,
    };
  }, NOTE);

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const files = await sourceFiles();
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await page.goto(baseUrl, { waitUntil: 'load' });
    const start = page.locator('[data-testid="start-import-midi"]');
    await start.waitFor({ state: 'visible', timeout: 30000 });
    const clipChooser = page.waitForEvent('filechooser');
    await start.click();
    await (await clipChooser).setFiles({
      name: 'velocity.midi2',
      mimeType: 'audio/midi',
      buffer: files.clip,
    });
    await page.waitForFunction(() => window.__sonareDebug?.lastMidiImportEvents() != null, null, {
      timeout: 30000,
    });
    const fromClip = await importedNoteOn(page);
    if (fromClip?.type !== 0x4 || fromClip.velocity !== VELOCITY_16) {
      fail(
        `the clip file import did not keep the 16-bit velocity 0x${VELOCITY_16.toString(16)}: ` +
          JSON.stringify(fromClip),
      );
      return;
    }
    const stored = await page.evaluate((note) => {
      const doc = window.__sonareDebug.projectDocument();
      return doc.tracks
        .flatMap((track) => track.clips.flatMap((clip) => clip.notes ?? []))
        .filter((entry) => entry.pitch === note)
        .map((entry) => entry.velocity);
    }, NOTE);
    if (stored.length !== 1 || stored[0] !== VELOCITY_16 >> 9) {
      fail(`the document does not hold the note at its 7-bit velocity: ${JSON.stringify(stored)}`);
      return;
    }
    await skipTour(page);

    await page.click('.app-menubar__trigger:has-text("File")');
    const smfChooser = page.waitForEvent('filechooser');
    await page
      .locator('.menu-panel [role="menuitem"]')
      .filter({ hasText: /^Import MIDI\.\.\.$/ })
      .click();
    await page.evaluate(() => window.__sonareDebug.clearLastMidiImportEvents());
    await (await smfChooser).setFiles({
      name: 'velocity.mid',
      mimeType: 'audio/midi',
      buffer: files.smf,
    });
    await untilDoneAcceptingConfirms(
      page,
      async () => page.evaluate(() => window.__sonareDebug.lastMidiImportEvents() != null),
      30000,
    );
    const fromSmf = await importedNoteOn(page);
    if (fromSmf === null || fromSmf.velocity === VELOCITY_16 || fromSmf.velocity > 127) {
      fail(`the SMF import did not read a 7-bit velocity: ${JSON.stringify(fromSmf)}`);
      return;
    }
    console.info(
      `MIDI 2.0 clip file: velocity 0x${fromClip.velocity.toString(16)} read exactly; ` +
        `the same note through SMF: 7-bit velocity ${fromSmf.velocity}`,
    );
  } finally {
    await context.close();
  }
}
