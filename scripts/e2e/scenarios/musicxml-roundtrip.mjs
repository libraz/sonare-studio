import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';
import { untilDoneAcceptingConfirms, unzipSync } from '../harness.mjs';

/**
 * MusicXML: the active clip exports through the File menu as a plain file and
 * as a compressed .mxl, and each imports back through the File menu with its
 * notes intact. Each import starts from a project that differs from
 * what the file holds, so only a real import can satisfy the check. Runs in its
 * own browser context because an import replaces the open project.
 */
export const name = 'musicxml-roundtrip';

const MELODY_A = [
  { pitch: 60, startPpq: 0, durationPpq: 1 },
  { pitch: 62, startPpq: 1, durationPpq: 1 },
  { pitch: 64, startPpq: 2, durationPpq: 1 },
  { pitch: 65, startPpq: 3, durationPpq: 1 },
];
const MELODY_B = [
  { pitch: 67, startPpq: 0, durationPpq: 1 },
  { pitch: 69, startPpq: 1, durationPpq: 1 },
  { pitch: 71, startPpq: 2, durationPpq: 1 },
  { pitch: 72, startPpq: 3, durationPpq: 1 },
];
const SCRATCH = [{ pitch: 90, startPpq: 0, durationPpq: 1 }];
const TOLERANCE_PPQ = 0.01;

const MXL_MIME = 'application/vnd.recordare.musicxml';
const FORMATS = {
  musicxml: { item: /^Export clip as MusicXML/, extension: '.musicxml' },
  mxl: { item: /^Export clip as compressed MusicXML/, extension: '.mxl' },
};

/** Every MIDI note in the open project, in timeline order. */
const projectNotes = (page) =>
  page.evaluate(() =>
    window.__sonareDebug
      .projectDocument()
      .tracks.flatMap((track) => track.clips ?? [])
      .filter((clip) => (clip.kind ?? 'midi') === 'midi')
      .flatMap((clip) =>
        clip.notes.map((note) => ({
          pitch: note.pitch,
          startPpq: clip.startPpq + note.startPpq,
          durationPpq: note.durationPpq,
        })),
      )
      .sort((a, b) => a.startPpq - b.startPpq),
  );

/** True when the notes are exactly the melody, up to where its first note sits. */
function isMelody(notes, melody) {
  if (notes.length !== melody.length) return false;
  const origin = notes[0].startPpq;
  return notes.every(
    (note, index) =>
      note.pitch === melody[index].pitch &&
      Math.abs(note.startPpq - origin - melody[index].startPpq) < TOLERANCE_PPQ &&
      Math.abs(note.durationPpq - melody[index].durationPpq) < TOLERANCE_PPQ,
  );
}

const addClip = (page, label, startPpq, notes) =>
  page.evaluate(
    ([clipName, at, clipNotes]) =>
      window.__sonareDebug.addNotedMidiClip(clipName, at, 4, clipNotes),
    [label, startPpq, notes],
  );

/** Exports the active clip through the File menu and returns the file's bytes. */
async function exportActiveClip(page, format) {
  const { item, extension } = FORMATS[format];
  await page.evaluate(() => {
    window.__previousDownload = window.__sonareDebug.lastDownload();
  });
  await page.click('.app-menubar__trigger:has-text("File")');
  await page.locator('.menu-panel [role="menuitem"]').filter({ hasText: item }).click();
  await untilDoneAcceptingConfirms(
    page,
    () =>
      page.evaluate((ext) => {
        const download = window.__sonareDebug.lastDownload();
        return download?.filename.endsWith(ext) === true && download !== window.__previousDownload;
      }, extension),
    60000,
  );
  const bytes = await page.evaluate(async () => [
    ...new Uint8Array(await window.__sonareDebug.lastDownload().blob.arrayBuffer()),
  ]);
  return Buffer.from(bytes);
}

/** Problems with an .mxl archive against the container rule, empty when it conforms. */
function mxlProblems(bytes) {
  const problems = [];
  const firstName = bytes.subarray(30, 30 + bytes.readUInt16LE(26)).toString();
  if (bytes.readUInt32LE(0) !== 0x04034b50 || firstName !== 'mimetype') {
    problems.push(`first entry is ${JSON.stringify(firstName)}, not mimetype`);
  }
  if (bytes.readUInt16LE(8) !== 0) problems.push('mimetype is compressed');
  const entries = unzipSync(new Uint8Array(bytes));
  if (Buffer.from(entries.mimetype ?? []).toString() !== MXL_MIME) {
    problems.push('mimetype content differs');
  }
  const container = Buffer.from(entries['META-INF/container.xml'] ?? []).toString();
  const rootPath = container.match(/<rootfile[^>]*full-path="([^"]+)"/)?.[1];
  if (!rootPath || !entries[rootPath]) problems.push(`rootfile ${rootPath} is not archived`);
  return problems;
}

/** Takes the discard prompt a dirty project raises before an import, when there is one. */
async function acceptDiscardPrompt(page) {
  const modal = page.locator('.modal-card:has(.dialog-message)');
  try {
    await modal.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    return;
  }
  await modal.locator('button').last().click();
  await modal.waitFor({ state: 'detached', timeout: 10000 });
}

/** Imports a file through the File menu and waits until the project holds the melody. */
async function importFile(page, file, melody, fail, label) {
  let chooser = null;
  page.once('filechooser', (opened) => {
    chooser = opened;
  });
  await page.click('.app-menubar__trigger:has-text("File")');
  await page
    .locator('.menu-panel [role="menuitem"]')
    .filter({ hasText: /^Import MusicXML/ })
    .click();
  await acceptDiscardPrompt(page);
  await untilDoneAcceptingConfirms(page, async () => chooser !== null, 30000);
  await chooser.setFiles(file);
  try {
    await untilDoneAcceptingConfirms(
      page,
      async () => isMelody(await projectNotes(page), melody),
      60000,
    );
    console.info(`${label}: re-imported with its notes`);
  } catch (error) {
    fail(`${label}: ${error.message}; notes now ${JSON.stringify(await projectNotes(page))}`);
  }
}

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await openEmptyProject(page, baseUrl);
    await skipTour(page);

    await addClip(page, 'MusicXML melody', 0, MELODY_A);
    const xml = (await exportActiveClip(page, 'musicxml')).toString();
    const pitched = (xml.match(/<pitch>/g) ?? []).length;
    if (!xml.includes('<score-partwise') || pitched !== MELODY_A.length) {
      fail(`the exported file is not the clip's score: ${pitched} pitched notes`);
    } else {
      console.info(`MusicXML exported: ${xml.length} chars, ${pitched} pitched notes`);
    }

    // Plain MusicXML: an unrelated clip is added first, and the import replaces it.
    await addClip(page, 'Scratch', 100, SCRATCH);
    await importFile(
      page,
      {
        name: 'melody.musicxml',
        mimeType: 'application/vnd.recordare.musicxml+xml',
        buffer: Buffer.from(xml),
      },
      MELODY_A,
      fail,
      'MusicXML',
    );

    // Compressed .mxl: a different melody, exported from the app as an archive.
    await addClip(page, 'Second melody', 100, MELODY_B);
    const mxl = await exportActiveClip(page, 'mxl');
    const problems = mxlProblems(mxl);
    if (problems.length > 0) fail(`the exported .mxl breaks the container rule: ${problems}`);
    else console.info(`.mxl exported: ${mxl.length} bytes, container conforms`);
    await importFile(
      page,
      {
        name: 'second.mxl',
        mimeType: MXL_MIME,
        buffer: mxl,
      },
      MELODY_B,
      fail,
      '.mxl',
    );
  } finally {
    await context.close();
  }
}
