/**
 * E2E smoke test for the studio shell.
 *
 * Drives a headless Chrome against a running dev server and verifies that the
 * piano roll renders, double-click creates a note, Cmd+Z undoes it, the score
 * panel engraves, a track and a clip can be created in the arrangement view,
 * a project saved to OPFS is restored after a page reload, a generated WAV
 * can be imported through the media browser and placed as an audio clip with
 * a drawn waveform, and a take recorded from the fake microphone lands as a
 * clip (via the dev-only window.__sonareDebug hook exposed by App.vue).
 *
 * Playwright is resolved from /tmp/node_modules. Usage:
 *   yarn dev --port 5199   # in the project root, in the background
 *   node scripts/e2e-smoke.mjs [baseUrl]
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire('/tmp/node_modules/');
const { chromium } = require('playwright');

const baseUrl = process.argv[2] ?? 'http://localhost:5199';

/** Fails the run with a message. */
function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

/** Builds a mono 16-bit PCM WAV file containing a sine tone. */
function makeWavBytes(seconds, frequencyHz, sampleRate = 44100, amplitude = 0.8) {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const sample = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * amplitude;
    data.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    // Fake microphone for the recording flow (tone generator, auto-granted).
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
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

  // Add a MIDI track via the arrangement header column's add-track menu.
  await page.click('.track-headers .add-track');
  await page.click('.add-track-items button:has-text("MIDI track")');
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

  // --- Audio: import a generated WAV through the media browser ---------------

  const wavPath = join(tmpdir(), 'sonare-e2e-tone.wav');
  writeFileSync(wavPath, makeWavBytes(0.5, 440));

  await page.click('.dock-tabs button:has-text("Media")');
  await page.setInputFiles('.media-browser .file-input', wavPath);
  const assetRow = page.locator('.media-browser .asset-row', { hasText: 'sonare-e2e-tone' });
  await assetRow.first().waitFor({ state: 'visible', timeout: 20000 });
  console.info('audio asset imported: media browser row visible');

  // "Add" places the asset at the playhead, creating an audio track.
  const tracksBeforeAdd = await page.evaluate(() => window.__sonareDebug.trackCount());
  const clipsBeforeAdd = await page.evaluate(() => window.__sonareDebug.clipCount());
  await assetRow.first().locator('.add-button').click();
  await page.waitForFunction(
    (before) => window.__sonareDebug.clipCount() === before + 1,
    clipsBeforeAdd,
    { timeout: 10000 },
  );
  const audioClips = await page.evaluate(() => window.__sonareDebug.audioClipCount());
  const clipKinds = await page.evaluate(() => window.__sonareDebug.clipKinds());
  if (audioClips !== 1 || clipKinds[clipKinds.length - 1] !== 'audio') {
    fail(`expected one audio clip, got audioClipCount=${audioClips} kinds=${clipKinds}`);
  } else {
    console.info(`audio clip added: ${clipsBeforeAdd} -> ${clipsBeforeAdd + 1} (kind audio)`);
  }
  const tracksAfterAdd = await page.evaluate(() => window.__sonareDebug.trackCount());
  if (tracksAfterAdd !== tracksBeforeAdd + 1) {
    fail(`expected an audio track to be created (${tracksBeforeAdd} -> ${tracksAfterAdd})`);
  } else {
    console.info('audio track auto-created for the asset');
  }

  // The clip sits at PPQ 0 on the last lane; once the asset loads, waveform
  // columns paint colors there that an empty stretch of the same lane lacks.
  const laneIndex = tracksAfterAdd - 1;
  const deadline = Date.now() + 20000;
  let waveformStats = { novelColors: 0, litPixels: 0 };
  while (Date.now() < deadline) {
    waveformStats = await page.evaluate((lane) => {
      const canvas = document.querySelector('.arrangement-canvas canvas');
      if (!(canvas instanceof HTMLCanvasElement)) return { novelColors: 0, litPixels: 0 };
      const ctx = canvas.getContext('2d');
      const scaleX = canvas.width / canvas.clientWidth;
      const scaleY = canvas.height / canvas.clientHeight;
      const laneTop = 28 + lane * 56;
      const read = (cssX) =>
        ctx.getImageData(
          Math.round(cssX * scaleX),
          Math.round((laneTop + 4) * scaleY),
          Math.max(1, Math.round(8 * scaleX)),
          Math.max(1, Math.round(48 * scaleY)),
        );
      const colorCounts = (img) => {
        const counts = new Map();
        for (let i = 0; i < img.data.length; i += 4) {
          const key = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return counts;
      };
      // 0.5 s at 120 BPM is 1 PPQ = 10 px at the default zoom; compare the
      // clip body against an empty stretch of the same lane.
      const clipColors = colorCounts(read(1));
      const emptyColors = colorCounts(read(canvas.clientWidth * 0.8));
      let novelColors = 0;
      let litPixels = 0;
      for (const [color, count] of clipColors) {
        if (emptyColors.has(color)) continue;
        novelColors += 1;
        litPixels += count;
      }
      return { novelColors, litPixels };
    }, laneIndex);
    // At least the clip fill plus waveform columns, covering most of the body.
    if (waveformStats.novelColors >= 2 && waveformStats.litPixels >= 100) break;
    await page.waitForTimeout(250);
  }
  if (waveformStats.novelColors < 2 || waveformStats.litPixels < 100) {
    fail(`audio clip waveform not drawn: ${JSON.stringify(waveformStats)}`);
  } else {
    console.info(
      `audio waveform drawn: ${waveformStats.novelColors} clip color(s), ${waveformStats.litPixels} px`,
    );
  }

  // --- Audio: record from the fake microphone --------------------------------

  await page.click('.transport-bar button:has-text("Start engine")');
  await page.waitForSelector('.transport-bar button:not([disabled]):has-text("Play")', {
    timeout: 60000,
  });
  console.info('engine started');

  // Move the playhead away from the imported clip, then arm the audio track.
  const arrangeBox2 = await page.locator('.arrangement-canvas').boundingBox();
  await page.mouse.click(arrangeBox2.x + 300, arrangeBox2.y + 14);
  await page.click(`.track-headers .track-header:nth-child(${laneIndex + 1}) .toggle.arm`);
  await page.waitForFunction(() => window.__sonareDebug.armedTrackId() !== null, null, {
    timeout: 5000,
  });
  console.info('audio track armed');

  const clipsBeforeRecord = await page.evaluate(() => window.__sonareDebug.audioClipCount());
  await page.click('.transport-bar .record-button');
  await page.waitForFunction(() => window.__sonareDebug.isRecording() === true, null, {
    timeout: 20000,
  });
  await page.waitForTimeout(1000);
  await page.click('.transport-bar .record-button');
  await page.waitForFunction(
    (before) => window.__sonareDebug.audioClipCount() === before + 1,
    clipsBeforeRecord,
    { timeout: 20000 },
  );
  console.info(`recorded take landed as a clip: ${clipsBeforeRecord} -> ${clipsBeforeRecord + 1}`);
  await page.click('.transport-bar button:has-text("Stop")');

  if (process.exitCode !== 1) console.info('E2E SMOKE PASS');
} catch (err) {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  await browser.close();
}
