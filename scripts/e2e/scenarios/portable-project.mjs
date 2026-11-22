import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { makeWavBytes, unzipSync } from '../harness.mjs';

/** Export a MIDI/audio/SF2 project as a portable SZD and reopen it cleanly. */
export const name = 'portable-project';

const sf2Path = fileURLToPath(new URL('../fixtures/minimal_gs.sf2', import.meta.url));
const midiFileName = 'portable-midi.mid';
const audioFileName = 'portable-audio.wav';
const portableFileName = 'portable-project.szd';

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
  const title = 'Portable Lead';
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
    64,
    100,
    ...vlq(480),
    0x80,
    64,
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

async function importMidiFromStart(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.locator('[data-testid="start-import-midi"]').waitFor({ state: 'visible' });
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('[data-testid="start-import-midi"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: midiFileName,
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

async function addAudio(page) {
  await page.click('.dock-tabs button:has-text("Media")');
  await page.setInputFiles('.media-browser .file-input', {
    name: audioFileName,
    mimeType: 'audio/wav',
    buffer: makeWavBytes(1.5, 330, 44100, 0.45),
  });
  const asset = page.locator('.media-browser .asset-row', { hasText: 'portable-audio' }).first();
  await asset.waitFor({ state: 'visible', timeout: 20000 });
  const clipsBefore = await page.evaluate(() => window.__sonareDebug.clipCount());
  await asset.locator('.add-button').click();
  await page.waitForFunction(
    (before) => window.__sonareDebug.clipCount() === before + 1,
    clipsBefore,
    { timeout: 10000 },
  );
}

async function addSoundFontInstrument(page) {
  const midiClipId = await page.evaluate(() => window.__sonareDebug.midiClipIds()[0]);
  if (midiClipId === undefined) throw new Error('portable project has no MIDI clip for SF2 setup');
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), midiClipId);
  await page.waitForFunction((id) => window.__sonareDebug.activeClipId() === id, midiClipId, {
    timeout: 10000,
  });
  if (!(await page.locator('.device-rack').isVisible())) {
    await page.locator('.app-bar .devices-toggle').click();
  }
  await page.locator('.device-rack .instrument-button').click();
  await page.locator('.instrument-picker .picker-tab').filter({ hasText: 'SF2' }).click();
  const font = page.locator('.instrument-picker .font-option').first();
  if (!(await font.isVisible())) {
    await page.locator('.instrument-picker .load-sf2-input').setInputFiles(sf2Path);
    await font.waitFor({ state: 'visible', timeout: 10000 });
  }
  await font.click();
  await page.locator('.instrument-picker .use-sf2').click();
  await page.waitForFunction(
    () =>
      window.__sonareDebug
        .projectDocument()
        .tracks.some((track) => track.instrument?.kind === 'sf2') &&
      !window.__sonareDebug.applyPending(),
    null,
    { timeout: 30000 },
  );
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
          fadeInPpq: clip.fadeInPpq ?? 0,
          fadeOutPpq: clip.fadeOutPpq ?? 0,
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

async function shortExport(page) {
  return page.evaluate(() => window.__sonareDebug.exportProbe(false, { startPpq: 0, endPpq: 8 }));
}

async function exportSzd(page) {
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await page.click('.app-menubar__trigger:has-text("File")');
  await page.locator('[id="menubar-file-file_2e_exportSzd"]').click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error('portable SZD export produced no readable download path');
  const bytes = readFileSync(path);
  return {
    filename: download.suggestedFilename(),
    base64: bytes.toString('base64'),
    byteLength: bytes.byteLength,
  };
}

async function importSzdFromStart(page, baseUrl, bytes) {
  // Chromium exposes showOpenFilePicker, but Playwright can only supply a
  // picked file through the app's real input-element fallback. This leaves
  // OPFS, workers and file bytes real while selecting the browser-compatible
  // input path used when the optional API is unavailable.
  await page.context().addInitScript(() => {
    try {
      Object.defineProperty(window, 'showOpenFilePicker', {
        configurable: true,
        value: undefined,
      });
    } catch {
      // The fallback input may already be the only available picker.
    }
  });
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.locator('[data-testid="start-import"]').waitFor({ state: 'visible' });
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('[data-testid="start-import"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: portableFileName,
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(bytes),
  });
  await page.waitForFunction(
    () => window.__sonareDebug?.initialized() === true && window.__sonareDebug.trackCount() > 0,
    null,
    { timeout: 60000 },
  );
  await skipTour(page);
}

async function editAndUndo(page) {
  const midiClipId = await page.evaluate(() => window.__sonareDebug.midiClipIds()[0]);
  if (midiClipId === undefined) throw new Error('portable project has no MIDI clip to edit');
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), midiClipId);
  await page.click('.dock-tabs button:has-text("Piano Roll")');
  await page.locator('.note-grid canvas').first().waitFor({ state: 'visible' });
  await page.locator('.tool-palette .tool-button').nth(1).click();
  const point = await page.evaluate(() => {
    const grid = document.querySelector('.note-grid');
    const props = grid?.__vueParentComponent?.props;
    if (!grid || !props?.range) throw new Error('portable MIDI piano roll is unavailable');
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
    throw new Error('portable MIDI clip has no drawable empty cell');
  });
  const before = await page.evaluate(() => window.__sonareDebug.activeNotes().length);
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(
    (count) => window.__sonareDebug.activeNotes().length === count + 1,
    before,
    { timeout: 15000 },
  );
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(
    (count) => window.__sonareDebug.activeNotes().length === count,
    before,
    { timeout: 15000 },
  );
}

export async function run({ page, baseUrl, fail }) {
  const initial = await freshPage(page);
  const imported = await freshPage(page);
  try {
    await importMidiFromStart(initial.page, baseUrl);
    await addAudio(initial.page);
    await addSoundFontInstrument(initial.page);

    const before = await semanticState(initial.page);
    const exportBefore = await shortExport(initial.page);
    if (before.tracks.length < 2 || before.tracks.some((track) => track.clips.length === 0)) {
      fail(`portable source project is incomplete: ${JSON.stringify(before)}`);
    }
    if (!before.tracks.some((track) => track.instrument?.kind === 'sf2')) {
      fail(`portable source project has no SF2 instrument: ${JSON.stringify(before)}`);
    }
    if (exportBefore.riff !== 'RIFF' || exportBefore.totalFrames <= 0) {
      fail(`portable source export was invalid: ${JSON.stringify(exportBefore)}`);
    }

    const exported = await exportSzd(initial.page);
    const archive = unzipSync(Buffer.from(exported.base64, 'base64'));
    const entries = Object.keys(archive).sort();
    const audioEntries = entries.filter(
      (entry) => entry.startsWith('assets/') && entry.endsWith('.pcm'),
    );
    const fontEntries = entries.filter(
      (entry) => entry.startsWith('fonts/') && entry.endsWith('.sf2'),
    );
    if (!entries.includes('project.json') || !entries.includes('meta.json')) {
      fail(`portable SZD is missing its document metadata: ${entries.join(', ')}`);
    }
    if (audioEntries.length === 0) {
      fail(`portable SZD has no bundled audio payload: ${entries.join(', ')}`);
    }
    if (fontEntries.length === 0) {
      fail(`portable SZD has no bundled SF2 payload: ${entries.join(', ')}`);
    }
    console.info(
      `portable SZD exported ${exported.byteLength} bytes with ${audioEntries.length} audio and ${fontEntries.length} SF2 payload(s)`,
    );

    await importSzdFromStart(imported.page, baseUrl, Buffer.from(exported.base64, 'base64'));
    const after = await semanticState(imported.page);
    const exportAfter = await shortExport(imported.page);
    if (!sameJson(after, before)) {
      fail(
        `portable reopen changed semantic clips/instruments: ${JSON.stringify({ before, after })}`,
      );
    }
    if (
      exportAfter.riff !== 'RIFF' ||
      exportAfter.totalFrames <= 0 ||
      exportAfter.hash !== exportBefore.hash
    ) {
      fail(
        `portable reopen changed the short export: ${JSON.stringify({ before: exportBefore, after: exportAfter })}`,
      );
    }
    console.info(
      `portable reopen preserved ${after.tracks.length} tracks and export hash ${exportAfter.hash}`,
    );

    await editAndUndo(imported.page);
    const afterUndo = await semanticState(imported.page);
    if (!sameJson(afterUndo, before)) {
      fail(
        `portable re-edit Undo did not restore the imported project: ${JSON.stringify({ before, afterUndo })}`,
      );
    } else {
      console.info('portable reopen was edited and restored through Undo');
    }
  } finally {
    await Promise.allSettled([initial.context.close(), imported.context.close()]);
  }
}
