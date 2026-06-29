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
 * It then checks the mixer tab (one strip per track plus master), the device
 * rack (an instrument change re-schedules the project, insert add/bypass are
 * realtime with no re-schedule, a master limiter is audible live and matches
 * the offline export level, and two synth presets render different audio),
 * the step sequencer (a baked
 * pattern replaces the active clip's notes), the mastering tab (processors
 * added to the project chain change the rendered mixdown bytes), the audio
 * export dialog (a 16-bit WAV download with an audible peak and a loudness
 * report), MIDI exports (SMF and MIDI 2.0 clip-file downloads), and the
 * DAWproject export (a zip with a project.xml entry).
 * It also asserts cross-origin isolation, dismisses the first-run welcome
 * tour, applies a score annotation through the annotate palette, opens the
 * shortcut help with '?', remaps a shortcut in the settings dialog (with
 * localStorage persistence across the reload and a reset back to defaults),
 * and applies the named workspace layout presets.
 *
 * Playwright is resolved from /tmp/node_modules; fflate from the project's
 * own node_modules. Usage:
 *   yarn dev --port 5199   # in the project root, in the background
 *   node scripts/e2e-smoke.mjs [baseUrl]
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire('/tmp/node_modules/');
const { chromium } = require('playwright');
const projectRequire = createRequire(new URL('../node_modules/', import.meta.url));
const { unzipSync } = projectRequire('fflate');

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

  // The app must be cross-origin isolated (COOP/COEP) so SharedArrayBuffer
  // and the realtime engine's shared-memory transport are available.
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated === true);
  if (!isolated) {
    fail('crossOriginIsolated is not true (COOP/COEP headers missing)');
  } else {
    console.info('crossOriginIsolated: true');
  }

  // First run: the welcome tour auto-opens. Skip it (which stores the seen
  // flag, keeping it away after reloads) before driving the canvases below.
  await page.waitForSelector('.tour-tooltip', { timeout: 10000 });
  await page.click('.tour-tooltip .tour-skip');
  await page.waitForSelector('.tour-overlay', { state: 'detached', timeout: 5000 });
  const tourSeen = await page.evaluate(() => localStorage.getItem('sonare-studio.tourSeen'));
  if (tourSeen !== '1') {
    fail(`welcome tour seen flag not stored: ${JSON.stringify(tourSeen)}`);
  } else {
    console.info('welcome tour auto-opened on first run and was dismissed');
  }

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

  // --- Score annotations: apply a dynamic from the annotate palette ----------

  const dynamsBefore = await page.locator('.score-body svg g.dynam').count();
  if (dynamsBefore !== 0) {
    fail(`expected no dynamics glyphs before annotating, got ${dynamsBefore}`);
  }
  await page.click('.score-toolbar button:has-text("Annotate")');
  await page.locator('.score-body svg g.note').first().click();
  await page.waitForSelector('.annotation-palette', { timeout: 5000 });
  await page
    .locator('.annotation-palette .palette-dynamics')
    .filter({ hasText: /^f$/ })
    .first()
    .click();
  // The annotation command re-transcribes (debounced) and the engraved SVG
  // must come back containing a dynamics glyph. MIDI itself never changes.
  await page.waitForFunction(
    () => document.querySelectorAll('.score-body svg g.dynam').length > 0,
    null,
    { timeout: 60000 },
  );
  console.info('score annotation engraved: dynamics glyph rendered in the SVG');
  await page.click('.annotation-palette button[aria-label="Close annotation palette"]');
  await page.click('.score-toolbar button:has-text("Annotate")');
  await page.waitForSelector('.annotation-palette', { state: 'detached', timeout: 5000 });
  console.info('annotate mode toggled off, palette closed');

  // --- Shortcut help overlay: '?' opens, Escape closes, focus returns --------

  await page.click('.dock-tabs button:has-text("Piano Roll")');
  await page.keyboard.press('?');
  await page.waitForSelector('[role="dialog"][aria-label="Keyboard shortcuts"]', {
    timeout: 5000,
  });
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"][aria-label="Keyboard shortcuts"]', {
    state: 'detached',
    timeout: 5000,
  });
  const focusAfterHelp = await page.evaluate(() => document.activeElement?.textContent?.trim());
  if (focusAfterHelp !== 'Piano Roll') {
    fail(`focus did not return to the trigger after closing help: "${focusAfterHelp}"`);
  } else {
    console.info("shortcut help opened with '?', closed with Escape, focus restored");
  }

  // --- Settings: remap a shortcut by key capture and verify it works ---------

  await page.click('.settings-button');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 5000 });
  await page.click('[role="dialog"][aria-label="Settings"] [role="tab"]:has-text("Shortcuts")');
  await page.click('tr[data-action-id="view.toggleScorePanel"] button[aria-label^="Change keys"]');
  await page.keyboard.press('F9');
  const remapKeys = await page.evaluate(() => {
    const raw = localStorage.getItem('sonare-studio.shortcuts');
    return raw ? (JSON.parse(raw).overrides?.['view.toggleScorePanel'] ?? null) : null;
  });
  if (JSON.stringify(remapKeys) !== JSON.stringify(['f9'])) {
    fail(`shortcut override not stored: ${JSON.stringify(remapKeys)}`);
  }
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', {
    state: 'detached',
    timeout: 5000,
  });
  // The remapped key drives the action immediately: F9 toggles the score panel.
  await page.keyboard.press('F9');
  await page.waitForSelector('.score-host', { state: 'detached', timeout: 5000 });
  await page.keyboard.press('F9');
  await page.waitForSelector('.score-host', { timeout: 5000 });
  console.info('shortcut remapped to F9 via key capture and verified live');

  // --- Named layouts: presets rearrange the workspace -------------------------

  await page.click('.app-menubar__trigger:has-text("Window")');
  await page.locator('.menu-panel [role="menuitem"]').filter({ hasText: /^Mix$/ }).click();
  await page.waitForFunction(
    () => document.querySelector('.arrange-zone')?.style.flexBasis === '180px',
    null,
    { timeout: 5000 },
  );
  const mixTabActive = await page.evaluate(() =>
    document.querySelector('.dock-tabs button.active')?.textContent?.trim(),
  );
  const rackOpenAfterMix = await page.evaluate(
    () => document.querySelector('.right-zone') !== null,
  );
  if (mixTabActive !== 'Mixer' || rackOpenAfterMix) {
    fail(`Mix layout not applied: tab=${mixTabActive} rackOpen=${rackOpenAfterMix}`);
  } else {
    console.info('Mix layout applied: mixer tab, 180px arrangement, rack closed');
  }
  await page.click('.app-menubar__trigger:has-text("Window")');
  await page
    .locator('.menu-panel [role="menuitem"]')
    .filter({ hasText: /^Compose$/ })
    .click();
  await page.waitForSelector('.right-zone', { timeout: 5000 });
  const composeTabActive = await page.evaluate(() =>
    document.querySelector('.dock-tabs button.active')?.textContent?.trim(),
  );
  if (composeTabActive !== 'Piano Roll') {
    fail(`Compose layout not applied: tab=${composeTabActive}`);
  } else {
    console.info('Compose layout applied: piano roll tab, device rack open');
  }
  // Close the rack again so the device-rack step below starts from closed.
  await page.click('.transport-bar .devices-toggle');
  await page.waitForSelector('.right-zone', { state: 'detached', timeout: 5000 });

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
  await page.click('.app-menubar__trigger:has-text("File")');
  await page
    .locator('.menu-panel [role="menuitem"]')
    .filter({ hasText: /^Save$/ })
    .click();
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

  // The shortcut override must survive the reload (localStorage) and still
  // drive the action; the per-row reset must then restore the default.
  const persistedKeys = await page.evaluate(() => {
    const raw = localStorage.getItem('sonare-studio.shortcuts');
    return raw ? (JSON.parse(raw).overrides?.['view.toggleScorePanel'] ?? null) : null;
  });
  if (JSON.stringify(persistedKeys) !== JSON.stringify(['f9'])) {
    fail(`shortcut override lost across reload: ${JSON.stringify(persistedKeys)}`);
  }
  await page.keyboard.press('F9');
  await page.waitForSelector('.score-host', { timeout: 5000 });
  await page.keyboard.press('F9');
  await page.waitForSelector('.score-host', { state: 'detached', timeout: 5000 });
  console.info('remapped shortcut persisted across reload and still works');

  await page.click('.settings-button');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 5000 });
  await page.click('[role="dialog"][aria-label="Settings"] [role="tab"]:has-text("Shortcuts")');
  await page.click('tr[data-action-id="view.toggleScorePanel"] button[aria-label^="Reset keys"]');
  const afterReset = await page.evaluate(() => {
    const raw = localStorage.getItem('sonare-studio.shortcuts');
    return raw ? (JSON.parse(raw).overrides?.['view.toggleScorePanel'] ?? null) : null;
  });
  if (afterReset !== null) {
    fail(`shortcut reset did not clear the override: ${JSON.stringify(afterReset)}`);
  }
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', {
    state: 'detached',
    timeout: 5000,
  });
  console.info('shortcut reset restored the default binding');

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

  // Start-silent guard: with clips scheduled but the transport stopped, the
  // engine output meter must stay at silence until Play.
  await page.waitForTimeout(800);
  const idlePeakDb = await page.evaluate(() => window.__sonareDebug.meterPeakDb());
  if (idlePeakDb !== null && idlePeakDb > -90) {
    fail(`engine not silent after start (transport stopped): peak ${idlePeakDb} dB`);
  } else {
    console.info(`engine silent after start: peak ${idlePeakDb} dB`);
  }

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
  // The engine's input-capture meter must register the fake microphone tone.
  await page.waitForFunction(() => window.__sonareDebug.inputLevel() > 0.001, null, {
    timeout: 5000,
  });
  console.info('input level meter follows the engine input capture');
  await page.waitForTimeout(1000);
  await page.click('.transport-bar .record-button');
  await page.waitForFunction(
    (before) => window.__sonareDebug.audioClipCount() === before + 1,
    clipsBeforeRecord,
    { timeout: 20000 },
  );
  console.info(`recorded take landed as a clip: ${clipsBeforeRecord} -> ${clipsBeforeRecord + 1}`);
  await page.click('.transport-bar button:has-text("Stop")');

  // --- Input monitor: the mic is audible through the engine only when enabled -

  {
    await page.waitForTimeout(500);
    const idleBefore = await page.evaluate(() => window.__sonareDebug.meterPeakDb());
    if (idleBefore !== null && idleBefore > -90) {
      fail(`engine not silent before the monitor check: peak ${idleBefore} dB`);
    }
    await page.evaluate(() => window.__sonareDebug.setInputMonitor(true));
    await page.waitForFunction(
      () => {
        const peak = window.__sonareDebug.meterPeakDb();
        return peak !== null && peak > -60;
      },
      null,
      { timeout: 5000 },
    );
    await page.evaluate(() => window.__sonareDebug.setInputMonitor(false));
    await page.waitForFunction(
      () => {
        const peak = window.__sonareDebug.meterPeakDb();
        return peak !== null && peak <= -90;
      },
      null,
      { timeout: 5000 },
    );
    console.info('input monitor: fake mic audible only while monitoring is enabled');
  }

  // --- Mixer tab: one channel strip per track plus the master strip -----------

  await page.click('.dock-tabs button:has-text("Mixer")');
  await page.waitForSelector('.mixer-strips .channel-strip', { timeout: 10000 });
  const stripCount = await page.locator('.mixer-strips .channel-strip').count();
  const mixerTrackCount = await page.evaluate(() => window.__sonareDebug.trackCount());
  if (stripCount !== mixerTrackCount + 1) {
    fail(`expected ${mixerTrackCount} track strips + master, got ${stripCount} strips`);
  } else {
    console.info(`mixer shows ${mixerTrackCount} track strips + master`);
  }

  // --- Realtime mixer: mute silences playback without re-scheduling -----------

  const rulerBox = await page.locator('.arrangement-canvas').boundingBox();
  await page.mouse.click(rulerBox.x + 2, rulerBox.y + 14); // seek to the clips at PPQ 0
  await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
    timeout: 10000,
  });
  const scheduledBeforeMute = await page.evaluate(() => window.__sonareDebug.scheduledClipIds());
  await page.click('.transport-bar button:has-text("Play")');
  await page.waitForFunction(
    () => {
      const peak = window.__sonareDebug.meterPeakDb();
      return peak !== null && peak > -90;
    },
    null,
    { timeout: 5000 },
  );
  const muteToggles = page.locator('.mixer-strips .channel-strip .toggle.mute');
  const muteToggleCount = await muteToggles.count();
  for (let i = 0; i < muteToggleCount; i++) await muteToggles.nth(i).click();
  await page.waitForFunction(
    () => {
      const peak = window.__sonareDebug.meterPeakDb();
      return peak !== null && peak <= -90;
    },
    null,
    { timeout: 3000 },
  );
  await page.click('.transport-bar button:has-text("Stop")');
  const scheduledAfterMute = await page.evaluate(() => window.__sonareDebug.scheduledClipIds());
  const pendingAfterMute = await page.evaluate(() => window.__sonareDebug.applyPending());
  if (
    pendingAfterMute ||
    JSON.stringify(scheduledBeforeMute) !== JSON.stringify(scheduledAfterMute)
  ) {
    fail(
      `mute caused a re-schedule: pending=${pendingAfterMute}, clips ${scheduledBeforeMute.length} -> ${scheduledAfterMute.length}`,
    );
  }
  for (let i = 0; i < muteToggleCount; i++) await muteToggles.nth(i).click();
  await page.waitForTimeout(200);
  console.info('realtime mute: master silenced without re-scheduling');

  // --- Device rack: changing the instrument re-bounces the project ------------

  // Select the demo MIDI clip (lane 1 at PPQ 0) so the active track is MIDI.
  const arrangeBox3 = await page.locator('.arrangement-canvas').boundingBox();
  await page.mouse.click(arrangeBox3.x + 20, arrangeBox3.y + 28 + 28);
  await page.waitForFunction(() => window.__sonareDebug.activeClipId() !== -1, null, {
    timeout: 5000,
  });

  await page.click('.transport-bar .devices-toggle');
  await page.waitForSelector('.device-rack .instrument-button', { timeout: 10000 });
  console.info('device rack opened for the active MIDI track');

  // Let the post-recording reschedule settle before capturing the baseline.
  await page.waitForFunction(
    () =>
      window.__sonareDebug.applyPending() === false &&
      window.__sonareDebug.scheduledClipIds().length > 0,
    null,
    { timeout: 20000 },
  );
  const midiClipCount = await page.evaluate(() => window.__sonareDebug.engineMidiClipCount());
  if (midiClipCount < 1) {
    fail(`expected MIDI clips in the engine schedule, got ${midiClipCount}`);
  } else {
    console.info(`engine holds ${midiClipCount} realtime MIDI clip schedule(s)`);
  }
  const idsBeforeInstrument = await page.evaluate(() =>
    JSON.stringify(window.__sonareDebug.scheduledClipIds()),
  );

  await page.click('.device-rack .instrument-button');
  await page.waitForSelector('.instrument-picker .preset-option', { timeout: 10000 });
  const presetName = await page.evaluate(() => {
    const names = [...document.querySelectorAll('.instrument-picker .preset-option')].map((el) =>
      (el.textContent ?? '').trim(),
    );
    return names.find((name) => name === 'saw-lead') ?? names.find((name) => name !== 'e-piano');
  });
  if (!presetName) {
    fail('no alternative synth preset offered by the instrument picker');
  } else {
    await page
      .locator('.instrument-picker .preset-option')
      .filter({ hasText: new RegExp(`^${presetName}$`) })
      .first()
      .click();
    await page.waitForFunction(
      (name) => window.__sonareDebug.trackInstruments().includes(name),
      presetName,
      { timeout: 10000 },
    );
    await page.waitForTimeout(400);
    const instrumentState = await page.evaluate(() => ({
      pending: window.__sonareDebug.applyPending(),
      ids: JSON.stringify(window.__sonareDebug.scheduledClipIds()),
    }));
    if (instrumentState.pending || instrumentState.ids !== idsBeforeInstrument) {
      fail(`instrument change caused a re-schedule: pending=${instrumentState.pending}`);
    }
    console.info(`instrument changed to "${presetName}" without re-scheduling (realtime synth)`);
  }

  // Two presets must render audibly different buffers through the real wasm.
  const probeA = await page.evaluate(() => window.__sonareDebug.renderProbe('e-piano'));
  const probeB = await page.evaluate(
    (name) => window.__sonareDebug.renderProbe(name),
    presetName ?? 'saw-lead',
  );
  if (probeA.frames === 0 || probeB.frames === 0 || probeA.hash === probeB.hash) {
    fail(`presets render identical audio: ${JSON.stringify({ probeA, probeB })}`);
  } else {
    console.info(
      `render probe differs: e-piano ${probeA.hash} (peak ${probeA.peak.toFixed(4)}) vs ` +
        `${presetName} ${probeB.hash} (peak ${probeB.peak.toFixed(4)})`,
    );
  }

  // --- Device rack: insert add/bypass are realtime (no re-schedule) -----------

  const insertChoice = await page.evaluate(() => {
    const values = [...document.querySelectorAll('.device-rack .add-insert option')]
      .map((el) => el.value)
      .filter((value) => value.length > 0);
    return (
      values.find((value) => value === 'saturation.softClipper') ??
      values.find((value) => value.startsWith('dynamics.')) ??
      values[0] ??
      null
    );
  });
  if (!insertChoice) {
    fail('device rack offers no insert processors');
  } else {
    const idsBeforeInsert = await page.evaluate(() =>
      JSON.stringify(window.__sonareDebug.scheduledClipIds()),
    );
    const insertCountsBefore = await page.evaluate(() =>
      JSON.stringify(window.__sonareDebug.trackInsertCounts()),
    );
    await page.selectOption('.device-rack .add-insert', insertChoice);
    await page.waitForFunction(
      (before) => JSON.stringify(window.__sonareDebug.trackInsertCounts()) !== before,
      insertCountsBefore,
      { timeout: 10000 },
    );
    await page.waitForTimeout(400);
    const insertAddState = await page.evaluate(() => ({
      pending: window.__sonareDebug.applyPending(),
      ids: JSON.stringify(window.__sonareDebug.scheduledClipIds()),
    }));
    if (insertAddState.pending || insertAddState.ids !== idsBeforeInsert) {
      fail(`insert add caused a re-schedule: pending=${insertAddState.pending}`);
    }
    console.info(`insert "${insertChoice}" added without re-scheduling`);

    const statesBeforeBypass = await page.evaluate(() =>
      JSON.stringify(window.__sonareDebug.trackInsertStates()),
    );
    await page.click('.device-rack .insert-power');
    await page.waitForFunction(
      (before) => JSON.stringify(window.__sonareDebug.trackInsertStates()) !== before,
      statesBeforeBypass,
      { timeout: 10000 },
    );
    await page.waitForTimeout(400);
    const bypassState = await page.evaluate(() => ({
      pending: window.__sonareDebug.applyPending(),
      ids: JSON.stringify(window.__sonareDebug.scheduledClipIds()),
    }));
    if (bypassState.pending || bypassState.ids !== idsBeforeInsert) {
      fail(`insert bypass caused a re-schedule: pending=${bypassState.pending}`);
    }
    console.info('insert bypass toggled without re-scheduling');
  }

  // --- Realtime strip DSP: a master limiter is audible live and in the export -

  {
    const masterInsertsBefore = await page.evaluate(() => window.__sonareDebug.masterInsertCount());
    if (masterInsertsBefore !== 0) {
      fail(`expected an empty master insert chain, got ${masterInsertsBefore}`);
    }
    const rulerBox4 = await page.locator('.arrangement-canvas').boundingBox();
    await page.mouse.click(rulerBox4.x + 2, rulerBox4.y + 14); // seek to PPQ 0
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 10000,
    });
    const idsBeforeStrip = await page.evaluate(() =>
      JSON.stringify(window.__sonareDebug.scheduledClipIds()),
    );
    await page.click('.transport-bar button:has-text("Play")');
    await page.waitForFunction(
      () => {
        const peak = window.__sonareDebug.meterPeakDb();
        return peak !== null && peak > -90;
      },
      null,
      { timeout: 5000 },
    );
    // The fixed thresholds below assume a healthy playback level; sample the
    // meter briefly to prove the premise.
    let peakBefore = -120;
    for (let i = 0; i < 8; i++) {
      const peak = await page.evaluate(() => window.__sonareDebug.meterPeakDb());
      if (peak !== null && peak > peakBefore) peakBefore = peak;
      await page.waitForTimeout(100);
    }
    if (peakBefore <= -40) {
      fail(`playback too quiet for the limiter check: peak ${peakBefore.toFixed(1)} dB`);
    }

    // A brickwall limiter with a -60 dB ceiling must cap the master output
    // immediately, with no re-schedule.
    await page.evaluate(() =>
      window.__sonareDebug.addMasterInsert('dynamics.brickwallLimiter', { ceilingDb: -60 }),
    );
    await page.waitForFunction(
      () => {
        const peak = window.__sonareDebug.meterPeakDb();
        return peak !== null && peak <= -50;
      },
      null,
      { timeout: 5000 },
    );
    const peakLimited = await page.evaluate(() => window.__sonareDebug.meterPeakDb());

    // Bypassing the limiter must restore the level, still without re-scheduling.
    await page.evaluate(() => window.__sonareDebug.setMasterInsertEnabled(0, false));
    await page.waitForFunction(
      () => {
        const peak = window.__sonareDebug.meterPeakDb();
        return peak !== null && peak > -45;
      },
      null,
      { timeout: 5000 },
    );
    await page.evaluate(() => window.__sonareDebug.setMasterInsertEnabled(0, true));
    await page.waitForFunction(
      () => {
        const peak = window.__sonareDebug.meterPeakDb();
        return peak !== null && peak <= -50;
      },
      null,
      { timeout: 5000 },
    );
    await page.click('.transport-bar button:has-text("Stop")');

    const stripState = await page.evaluate(() => ({
      pending: window.__sonareDebug.applyPending(),
      ids: JSON.stringify(window.__sonareDebug.scheduledClipIds()),
    }));
    if (stripState.pending || stripState.ids !== idsBeforeStrip) {
      fail(`master insert edits caused a re-schedule: pending=${stripState.pending}`);
    }
    console.info(
      `realtime master limiter: live peak capped to ${peakLimited?.toFixed(1)} dB without re-scheduling`,
    );

    // Chain equivalence: the offline export must apply the same limiter and
    // land in the same loudness ballpark as the live engine.
    const exportLimited = await page.evaluate(() => window.__sonareDebug.exportProbe(true));
    if (exportLimited.peakDb > -50 || exportLimited.peakDb < -75) {
      fail(`export ignored the master limiter: peak ${exportLimited.peakDb} dB`);
    }
    if (peakLimited !== null && Math.abs(exportLimited.peakDb - peakLimited) > 8) {
      fail(
        `realtime vs export diverge: live ${peakLimited.toFixed(1)} dB, export ${exportLimited.peakDb.toFixed(1)} dB`,
      );
    }
    console.info(
      `chain equivalence: live ${peakLimited?.toFixed(1)} dB vs export ${exportLimited.peakDb.toFixed(1)} dB`,
    );
    await page.evaluate(() => window.__sonareDebug.removeMasterInsert(0));
    await page.waitForFunction(() => window.__sonareDebug.masterInsertCount() === 0, null, {
      timeout: 5000,
    });
  }

  // --- Steps tab: bake a 4-step pattern into the active clip ------------------

  await page.click('.dock-tabs button:has-text("Steps")');
  await page.waitForSelector('.step-sequencer [data-test="apply"]:not([disabled])', {
    timeout: 10000,
  });
  for (const step of [0, 4, 8, 12]) {
    await page.click(`.step-grid .grid-cell[data-row="0"][data-step="${step}"]`);
  }
  const notesBeforeApply = await page.evaluate(() => window.__sonareDebug.noteCount());
  await page.click('.step-sequencer [data-test="apply"]');
  await page.waitForFunction(() => window.__sonareDebug.noteCount() === 4, null, {
    timeout: 10000,
  });
  console.info(`step pattern applied: ${notesBeforeApply} -> 4 notes`);

  // --- Realtime MIDI: note edits play without a re-bounce ---------------------

  {
    await page.waitForTimeout(400);
    const stepsPending = await page.evaluate(() => window.__sonareDebug.applyPending());
    if (stepsPending) {
      fail('step bake caused an audio re-bounce (MIDI edits must be realtime)');
    }
    // Mute the audio track: anything audible at PPQ 0 must then come from the
    // engine's realtime MIDI instruments (MIDI clips are never bounced to
    // audio clips anymore).
    await page.click('.dock-tabs button:has-text("Mixer")');
    await page.waitForSelector('.mixer-strips .channel-strip', { timeout: 10000 });
    const audioMute = page.locator('.mixer-strips .channel-strip .toggle.mute').nth(2);
    await audioMute.click();
    const rulerBox5 = await page.locator('.arrangement-canvas').boundingBox();
    await page.mouse.click(rulerBox5.x + 2, rulerBox5.y + 14);
    await page.click('.transport-bar button:has-text("Play")');
    await page.waitForFunction(
      () => {
        const peak = window.__sonareDebug.meterPeakDb();
        return peak !== null && peak > -90;
      },
      null,
      { timeout: 5000 },
    );
    await page.click('.transport-bar button:has-text("Stop")');
    await audioMute.click();
    console.info('realtime MIDI: baked pattern audible through the engine instruments');
  }

  // --- Per-lane meters: each track meter follows its own engine lane ----------

  {
    const ids = await page.evaluate(() => window.__sonareDebug.trackIds());
    const midiTrackId = ids[0]; // demo MIDI track
    const audioTrackId = ids[2]; // imported-audio track (clip at PPQ 0)
    const rulerBox6 = await page.locator('.arrangement-canvas').boundingBox();
    await page.mouse.click(rulerBox6.x + 2, rulerBox6.y + 14);
    await page.click('.transport-bar button:has-text("Play")');
    await page.waitForFunction(
      ([midiId, audioId]) => {
        const a = window.__sonareDebug.trackMeterDb(midiId);
        const b = window.__sonareDebug.trackMeterDb(audioId);
        return a !== null && a > -90 && b !== null && b > -90;
      },
      [midiTrackId, audioTrackId],
      { timeout: 5000 },
    );
    const lufs = await page.evaluate(() => window.__sonareDebug.masterLufs());
    if (lufs === null || !(lufs > -70)) {
      fail(`master meter lost its loudness record: momentary LUFS ${lufs}`);
    }
    // Muting one lane must silence only that lane's meter.
    const midiMute = page.locator('.mixer-strips .channel-strip .toggle.mute').nth(0);
    await midiMute.click();
    await page.waitForFunction(
      ([midiId, audioId]) => {
        const a = window.__sonareDebug.trackMeterDb(midiId);
        const b = window.__sonareDebug.trackMeterDb(audioId);
        return a !== null && a <= -90 && b !== null && b > -90;
      },
      [midiTrackId, audioTrackId],
      { timeout: 5000 },
    );
    await page.click('.transport-bar button:has-text("Stop")');
    await midiMute.click();
    console.info(`per-lane meters independent (master momentary LUFS ${lufs.toFixed(1)})`);
  }

  // --- Tempo map: segments drive the engine timeline and the playhead ---------

  {
    await page.evaluate(() =>
      window.__sonareDebug.setTempoSegments([
        { startPpq: 0, bpm: 120 },
        { startPpq: 4, bpm: 60 },
      ]),
    );
    // A tempo change re-bounces audio clips; let it settle.
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });
    const rulerBox7 = await page.locator('.arrangement-canvas').boundingBox();
    await page.mouse.click(rulerBox7.x + 2, rulerBox7.y + 14);
    await page.click('.transport-bar button:has-text("Play")');
    // 120 BPM region: the playhead advances ~2 PPQ per second.
    const fastStart = await page.evaluate(() => window.__sonareDebug.positionPpq());
    await page.waitForTimeout(1500);
    const fastEnd = await page.evaluate(() => window.__sonareDebug.positionPpq());
    const fastRate = (fastEnd - fastStart) / 1.5;
    if (!(fastRate > 1.4 && fastRate < 2.6)) {
      fail(`playhead rate in the 120 BPM region off: ${fastRate.toFixed(2)} PPQ/s`);
    }
    // 60 BPM region: ~1 PPQ per second once past the segment boundary.
    await page.waitForFunction(() => window.__sonareDebug.positionPpq() > 4.5, null, {
      timeout: 8000,
    });
    const slowStart = await page.evaluate(() => window.__sonareDebug.positionPpq());
    await page.waitForTimeout(1500);
    const slowEnd = await page.evaluate(() => window.__sonareDebug.positionPpq());
    const slowRate = (slowEnd - slowStart) / 1.5;
    if (!(slowRate > 0.6 && slowRate < 1.4)) {
      fail(`playhead rate in the 60 BPM region off: ${slowRate.toFixed(2)} PPQ/s`);
    }
    await page.click('.transport-bar button:has-text("Stop")');
    console.info(
      `tempo map followed: ${fastRate.toFixed(2)} PPQ/s at 120 BPM, ${slowRate.toFixed(2)} PPQ/s at 60 BPM`,
    );

    // Loop boundaries hold under the tempo map.
    await page.evaluate(() => window.__sonareDebug.setLoopRange(0, 4, true));
    await page.mouse.click(rulerBox7.x + 2, rulerBox7.y + 14);
    await page.click('.transport-bar button:has-text("Play")');
    await page.waitForTimeout(3000);
    const loopedPpq = await page.evaluate(() => window.__sonareDebug.positionPpq());
    if (!(loopedPpq >= 0 && loopedPpq < 4.4)) {
      fail(`loop did not wrap at the segment tempo: position ${loopedPpq.toFixed(2)} PPQ`);
    }
    await page.click('.transport-bar button:has-text("Stop")');
    await page.evaluate(() => window.__sonareDebug.setLoopRange(0, 4, false));
    console.info(`loop wrapped inside [0, 4): position ${loopedPpq.toFixed(2)} PPQ`);

    // Restore the constant demo tempo for the remaining scenarios.
    await page.evaluate(() => window.__sonareDebug.setTempoSegments([{ startPpq: 0, bpm: 120 }]));
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });
  }

  // --- Automation volume ramp: a fader lane shapes the loop, removal restores -

  {
    // A steady looping source: a 2 s tone spans exactly [0, 4) PPQ at 120 BPM.
    const rampWavPath = join(tmpdir(), 'sonare-e2e-ramp-tone.wav');
    writeFileSync(rampWavPath, makeWavBytes(2, 330));
    const rulerBox8 = await page.locator('.arrangement-canvas').boundingBox();
    await page.mouse.click(rulerBox8.x + 2, rulerBox8.y + 14); // playhead to PPQ 0
    await page.click('.dock-tabs button:has-text("Media")');
    const tracksBeforeRamp = await page.evaluate(() => window.__sonareDebug.trackIds());
    const clipsBeforeRamp = await page.evaluate(() => window.__sonareDebug.clipCount());
    await page.setInputFiles('.media-browser .file-input', rampWavPath);
    const rampRow = page.locator('.media-browser .asset-row', { hasText: 'sonare-e2e-ramp-tone' });
    await rampRow.first().waitFor({ state: 'visible', timeout: 20000 });
    await rampRow.first().locator('.add-button').click();
    await page.waitForFunction(
      (before) => window.__sonareDebug.clipCount() === before + 1,
      clipsBeforeRamp,
      { timeout: 10000 },
    );
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });
    const rampTrackId = await page.evaluate(
      (before) => window.__sonareDebug.trackIds().find((id) => !before.includes(id)),
      tracksBeforeRamp,
    );

    // Baseline: the steady track level over one loop pass with no automation.
    await page.evaluate(() => window.__sonareDebug.setLoopRange(0, 4, true));
    await page.mouse.click(rulerBox8.x + 2, rulerBox8.y + 14);
    await page.click('.transport-bar button:has-text("Play")');
    await page.waitForFunction(
      (id) => {
        const db = window.__sonareDebug.trackMeterDb(id);
        return db !== null && db > -90;
      },
      rampTrackId,
      { timeout: 5000 },
    );
    let baselineDb = -120;
    for (let i = 0; i < 10; i++) {
      const db = await page.evaluate((id) => window.__sonareDebug.trackMeterDb(id), rampTrackId);
      if (db !== null && db > baselineDb) baselineDb = db;
      await page.waitForTimeout(100);
    }
    if (baselineDb <= -40) {
      fail(`ramp source too quiet for the automation check: ${baselineDb.toFixed(1)} dB`);
    }

    // Install a -60 dB -> 0 dB fader ramp across the loop.
    await page.evaluate(
      (id) =>
        window.__sonareDebug.setAutomationLanePoints(id, 'faderDb', [
          { ppq: 0, value: -60 },
          { ppq: 4, value: 0 },
        ]),
      rampTrackId,
    );
    await page.waitForFunction(() => window.__sonareDebug.automationLaneCount() >= 1, null, {
      timeout: 5000,
    });
    const installedIds = await page.evaluate(() =>
      window.__sonareDebug.automationInstalledParamIds(),
    );
    if (installedIds.length < 1) {
      fail(`no automation lane installed in the engine: ${JSON.stringify(installedIds)}`);
    }

    // Samples the lane meter once the playhead enters [minPpq, maxPpq).
    const sampleWindow = async (minPpq, maxPpq) => {
      await page.waitForFunction(
        ([lo, hi]) => {
          const ppq = window.__sonareDebug.positionPpq();
          return ppq >= lo && ppq < hi;
        },
        [minPpq, maxPpq],
        { timeout: 10000 },
      );
      return page.evaluate((id) => window.__sonareDebug.trackMeterDb(id), rampTrackId);
    };
    const earlyDb = await sampleWindow(0.5, 1.1);
    const lateDb = await sampleWindow(3.3, 3.9);
    if (earlyDb === null || lateDb === null || lateDb - earlyDb < 15) {
      fail(`fader ramp not audible: early ${earlyDb} dB, late ${lateDb} dB`);
    }
    // After the loop wraps, the curve must reapply: early is quiet again.
    const earlyDb2 = await sampleWindow(0.5, 1.1);
    if (earlyDb2 === null || lateDb - earlyDb2 < 15) {
      fail(`ramp did not reapply after the loop wrap: early ${earlyDb2} dB vs late ${lateDb} dB`);
    }
    console.info(
      `PASS automation volume ramp: early ${earlyDb.toFixed(1)} dB -> late ${lateDb.toFixed(1)} dB, ` +
        `post-wrap early ${earlyDb2.toFixed(1)} dB`,
    );

    // Removing the lane must restore the manual fader level.
    await page.evaluate(
      (id) => window.__sonareDebug.removeAutomationLane(id, 'faderDb'),
      rampTrackId,
    );
    await page.waitForFunction(
      () => window.__sonareDebug.automationInstalledParamIds().length === 0,
      null,
      { timeout: 5000 },
    );
    await page.waitForTimeout(600);
    let restoredDb = -120;
    for (let i = 0; i < 10; i++) {
      const db = await page.evaluate((id) => window.__sonareDebug.trackMeterDb(id), rampTrackId);
      if (db !== null && db > restoredDb) restoredDb = db;
      await page.waitForTimeout(100);
    }
    if (Math.abs(restoredDb - baselineDb) > 3) {
      fail(
        `level did not restore after lane removal: baseline ${baselineDb.toFixed(1)} dB, ` +
          `restored ${restoredDb.toFixed(1)} dB`,
      );
    }
    console.info(
      `PASS automation lane removed: level restored to ${restoredDb.toFixed(1)} dB ` +
        `(baseline ${baselineDb.toFixed(1)} dB)`,
    );
    await page.click('.transport-bar button:has-text("Stop")');
    await page.evaluate(() => window.__sonareDebug.setLoopRange(0, 4, false));

    // --- Automation write/read modes: W records a fader drag, R follows -------

    // The previous scenario removed the lane, so the write drag starts clean.
    const lanePointsBefore = await page.evaluate(
      (id) => window.__sonareDebug.automationLanePoints(id, 'faderDb'),
      rampTrackId,
    );
    if (lanePointsBefore.length !== 0) {
      fail(`fader lane present before the write test: ${JSON.stringify(lanePointsBefore)}`);
    }

    await page.click('.dock-tabs button:has-text("Mixer")');
    await page.waitForSelector('.mixer-strips .channel-strip', { timeout: 10000 });
    const stripIndex = await page.evaluate(
      (id) => window.__sonareDebug.trackIds().indexOf(id),
      rampTrackId,
    );
    const writeStrip = page.locator('.mixer-strips .channel-strip').nth(stripIndex);
    await writeStrip.locator('.strip-auto-w').click();
    await writeStrip.locator('.strip-auto-w.on').waitFor({ state: 'visible', timeout: 5000 });
    console.info('strip automation write mode engaged');

    // The fader's lower throw sits below the default 720px viewport fold, where
    // synthetic pointer events are silently dropped. Enlarge the viewport for
    // the drag and restore it at the end of the scenario.
    const savedViewport = page.viewportSize();
    await page.setViewportSize({ width: 1280, height: 960 });
    await writeStrip.locator('.fader-track').scrollIntoViewIfNeeded();

    // Record a rising fader drag across one loop pass ([0, 4) is 2 s at 120 BPM):
    // from ~10% of the throw (deep cut) up to ~75% (around unity).
    const faderBox = await writeStrip.locator('.fader-track').boundingBox();
    const faderX = faderBox.x + faderBox.width / 2;
    const dragYAt = (t) => faderBox.y + faderBox.height * (0.9 - 0.65 * t);
    await page.evaluate(() => window.__sonareDebug.setLoopRange(0, 4, true));
    await page.mouse.click(rulerBox8.x + 2, rulerBox8.y + 14); // playhead to PPQ 0
    await page.click('.transport-bar button:has-text("Play")');
    await page.waitForFunction(() => window.__sonareDebug.positionPpq() < 0.4, null, {
      timeout: 10000,
    });
    await page.mouse.move(faderX, dragYAt(0));
    await page.mouse.down();
    const dragSteps = 8;
    for (let i = 1; i <= dragSteps; i++) {
      await page.mouse.move(faderX, dragYAt(i / dragSteps));
      await page.waitForTimeout(160);
    }
    await page.mouse.up();
    await page.click('.transport-bar button:has-text("Stop")');

    // The drag must have produced a multi-point lane and stop drops W to R.
    const writtenPoints = await page.evaluate(
      (id) => window.__sonareDebug.automationLanePoints(id, 'faderDb'),
      rampTrackId,
    );
    if (writtenPoints.length < 2) {
      fail(`write drag recorded ${writtenPoints.length} point(s)`);
    }
    await writeStrip.locator('.strip-auto-r.on').waitFor({ state: 'visible', timeout: 5000 });
    const modeAfterStop = await page.evaluate(
      (id) => window.__sonareDebug.stripAutomationMode(id),
      rampTrackId,
    );
    if (modeAfterStop !== 'read') {
      fail(`stop did not drop write mode to read: mode ${modeAfterStop}`);
    }

    // Read-follow: the recorded ramp shapes the next loop pass audibly.
    await page.waitForFunction(
      () => window.__sonareDebug.automationInstalledParamIds().length >= 1,
      null,
      { timeout: 5000 },
    );
    await page.mouse.click(rulerBox8.x + 2, rulerBox8.y + 14);
    await page.click('.transport-bar button:has-text("Play")');
    const writeEarlyDb = await sampleWindow(0.5, 1.1);
    const writeLateDb = await sampleWindow(3.3, 3.9);
    if (writeEarlyDb === null || writeLateDb === null || writeLateDb - writeEarlyDb < 6) {
      fail(
        `recorded ramp not audible in read mode: early ${writeEarlyDb} dB, late ${writeLateDb} dB`,
      );
    }
    console.info(
      `PASS automation write/read modes: ${writtenPoints.length} points recorded, ` +
        `read-follow early ${writeEarlyDb.toFixed(1)} dB -> late ${writeLateDb.toFixed(1)} dB`,
    );

    await page.click('.transport-bar button:has-text("Stop")');
    await page.evaluate((id) => {
      window.__sonareDebug.removeAutomationLane(id, 'faderDb');
      window.__sonareDebug.setStripAutomationMode(id, 'off');
      window.__sonareDebug.setLoopRange(0, 4, false);
    }, rampTrackId);
    if (savedViewport) await page.setViewportSize(savedViewport);

    // --- Export equivalence: automation, sends and buses render in the export -

    // Isolate the steady tone: silence every other track with a held -120 dB
    // fader lane (audible live AND in the export, so the comparison stays
    // apples-to-apples).
    const eqRange = { startPpq: 0, endPpq: 4 };
    const otherIds = await page.evaluate(
      (keep) => window.__sonareDebug.trackIds().filter((id) => id !== keep),
      rampTrackId,
    );
    await page.evaluate((ids) => {
      for (const id of ids) {
        window.__sonareDebug.setAutomationLanePoints(id, 'faderDb', [
          { ppq: 0, value: -120, curve: 'hold' },
        ]);
      }
    }, otherIds);

    const probeBase = await page.evaluate(
      (range) => window.__sonareDebug.exportProbe(true, range),
      eqRange,
    );

    // A constant -24 dB fader lane must shift the exported peak down ~24 dB.
    await page.evaluate(
      (id) =>
        window.__sonareDebug.setAutomationLanePoints(id, 'faderDb', [
          { ppq: 0, value: -24, curve: 'hold' },
        ]),
      rampTrackId,
    );
    const probeAuto = await page.evaluate(
      (range) => window.__sonareDebug.exportProbe(true, range),
      eqRange,
    );
    await page.evaluate(
      (id) => window.__sonareDebug.removeAutomationLane(id, 'faderDb'),
      rampTrackId,
    );
    const autoShift = probeBase.peakDb - probeAuto.peakDb;
    if (!(autoShift > 18 && autoShift < 30)) {
      fail(
        `automation not rendered in export: base ${probeBase.peakDb.toFixed(1)} dB, ` +
          `with -24 dB lane ${probeAuto.peakDb.toFixed(1)} dB`,
      );
    }

    // A unity send into a unity bus must raise the exported level audibly.
    const eqBusId = await page.evaluate((id) => {
      const bus = window.__sonareDebug.addMixerBus('FX');
      window.__sonareDebug.setSend(id, bus, { levelDb: 0, enabled: true });
      return bus;
    }, rampTrackId);
    const probeSend = await page.evaluate(
      (range) => window.__sonareDebug.exportProbe(true, range),
      eqRange,
    );
    const sendLift = probeSend.peakDb - probeBase.peakDb;
    if (!(sendLift > 1.5)) {
      fail(
        `send/bus not rendered in export: base ${probeBase.peakDb.toFixed(1)} dB, ` +
          `with unity send ${probeSend.peakDb.toFixed(1)} dB`,
      );
    }

    // Live playback of the same window with the send active must land in the
    // exported level's ballpark (the meter is a block peak, so allow slack).
    await page.evaluate(() => window.__sonareDebug.setLoopRange(0, 4, true));
    await page.mouse.click(rulerBox8.x + 2, rulerBox8.y + 14);
    await page.click('.transport-bar button:has-text("Play")');
    let livePeak = Number.NEGATIVE_INFINITY;
    const liveDeadline = Date.now() + 2400;
    while (Date.now() < liveDeadline) {
      const peak = await page.evaluate(() => window.__sonareDebug.meterPeakDb());
      if (peak !== null && peak > livePeak) livePeak = peak;
      await page.waitForTimeout(100);
    }
    await page.click('.transport-bar button:has-text("Stop")');
    if (!Number.isFinite(livePeak) || Math.abs(livePeak - probeSend.peakDb) > 6) {
      fail(
        `live vs engine export diverge: live peak ${livePeak.toFixed(1)} dB, ` +
          `export ${probeSend.peakDb.toFixed(1)} dB`,
      );
    } else {
      console.info(
        `PASS export equivalence: automation shift ${autoShift.toFixed(1)} dB, ` +
          `send lift ${sendLift.toFixed(1)} dB, live ${livePeak.toFixed(1)} dB vs ` +
          `export ${probeSend.peakDb.toFixed(1)} dB`,
      );
    }

    // Stems: isolated per-track engine passes. With the send/bus removed and
    // the -120 dB lanes still silencing the other tracks, the tone track's
    // stem must carry the (pre-master) mix level while every other stem stays
    // far below it.
    await page.evaluate(
      ([id, bus]) => {
        window.__sonareDebug.setSend(id, bus, null);
        window.__sonareDebug.removeMixerBus(bus);
      },
      [rampTrackId, eqBusId],
    );
    const allIds = await page.evaluate(() => window.__sonareDebug.trackIds());
    const rampIndex = allIds.indexOf(rampTrackId);
    const probeNoMaster = await page.evaluate(
      (range) => window.__sonareDebug.exportProbe(false, range),
      eqRange,
    );
    const probeStems = await page.evaluate(
      (range) => window.__sonareDebug.exportProbe(false, range, true),
      eqRange,
    );
    const stemList = probeStems.stems ?? [];
    const rampStem = stemList.find((stem) => stem.trackIndex === rampIndex);
    const otherPeaks = stemList
      .filter((stem) => stem.trackIndex !== rampIndex)
      .map((stem) => stem.peakDb);
    const otherMax = otherPeaks.length > 0 ? Math.max(...otherPeaks) : Number.NEGATIVE_INFINITY;
    if (
      stemList.length !== allIds.length ||
      !rampStem ||
      Math.abs(rampStem.peakDb - probeNoMaster.peakDb) > 2 ||
      otherMax > -40
    ) {
      fail(
        `stems not isolated: ${stemList.length}/${allIds.length} stems, tone stem ` +
          `${rampStem ? rampStem.peakDb.toFixed(1) : 'missing'} dB vs mix ` +
          `${probeNoMaster.peakDb.toFixed(1)} dB, max other ${otherMax.toFixed(1)} dB`,
      );
    } else {
      console.info(
        `PASS export stems: ${stemList.length} stems, tone stem ${rampStem.peakDb.toFixed(1)} dB ` +
          `(mix ${probeNoMaster.peakDb.toFixed(1)} dB), max other stem ${otherMax.toFixed(1)} dB`,
      );
    }

    await page.evaluate((others) => {
      for (const other of others) window.__sonareDebug.removeAutomationLane(other, 'faderDb');
      window.__sonareDebug.setLoopRange(0, 4, false);
    }, otherIds);
  }

  // --- Cycle recording: loop takes, comp switching, flatten -------------------

  {
    // Record ~2.3 loop passes onto a fresh audio track: the linear capture
    // must split at the loop boundaries into one clip with one take per
    // completed pass.
    const recTrackId = await page.evaluate(() => {
      const id = window.__sonareDebug.addAudioTrack('Cycle rec');
      window.__sonareDebug.armTrack(id);
      window.__sonareDebug.setLoopRange(0, 4, true);
      window.__sonareDebug.seekPpq(0);
      return id;
    });
    await page.click('.transport-bar .record-button');
    await page.waitForFunction(() => window.__sonareDebug.isRecording() === true, null, {
      timeout: 10000,
    });
    // One loop pass is 2 s (4 ppq at 120 bpm); capture two complete passes.
    await page.waitForTimeout(4700);
    await page.click('.transport-bar .record-button');
    await page.waitForFunction(
      (id) => window.__sonareDebug.clipTakesInfo(id).length === 1,
      recTrackId,
      { timeout: 10000 },
    );
    await page.click('.transport-bar button:has-text("Stop")');
    const recInfo = (
      await page.evaluate((id) => window.__sonareDebug.clipTakesInfo(id), recTrackId)
    )[0];
    if (recInfo.takeCount < 2 || recInfo.startPpq !== 0 || Math.abs(recInfo.lengthPpq - 4) > 1e-6) {
      fail(
        `cycle recording did not split takes: ${recInfo.takeCount} takes, ` +
          `clip ${recInfo.startPpq}..${recInfo.startPpq + recInfo.lengthPpq} ppq`,
      );
    }

    // Deterministic comp content: replace the takes with two tones 12 dB
    // apart, silence every other track, and verify take switching, partial
    // comp segments and flattening through the real export path.
    const otherIds = await page.evaluate(
      (keep) => window.__sonareDebug.trackIds().filter((id) => id !== keep),
      recTrackId,
    );
    await page.evaluate(
      async ([clipId, others]) => {
        for (const id of others) {
          window.__sonareDebug.setAutomationLanePoints(id, 'faderDb', [
            { ppq: 0, value: -120, curve: 'hold' },
          ]);
        }
        const loud = await window.__sonareDebug.ingestToneAsset(2.0, 330, 0.8);
        const quiet = await window.__sonareDebug.ingestToneAsset(2.0, 330, 0.2);
        window.__sonareDebug.setClipTakes(
          clipId,
          [
            { assetId: loud, name: 'Take A' },
            { assetId: quiet, name: 'Take B' },
          ],
          0,
        );
      },
      [recInfo.clipId, otherIds],
    );
    const probeWindow = (startPpq, endPpq) =>
      page.evaluate((range) => window.__sonareDebug.exportProbe(false, range), {
        startPpq,
        endPpq,
      });
    const takeA = (await probeWindow(0, 4)).peakDb;
    await page.evaluate(
      (clipId) => window.__sonareDebug.setClipActiveTake(clipId, 1),
      recInfo.clipId,
    );
    const takeB = (await probeWindow(0, 4)).peakDb;
    if (!(takeA - takeB > 10 && takeA - takeB < 14)) {
      fail(
        `take switch not audible in export: take A ${takeA.toFixed(1)} dB, take B ${takeB.toFixed(1)} dB`,
      );
    }

    await page.evaluate(
      (clipId) =>
        window.__sonareDebug.setClipCompSegments(clipId, [
          { startPpq: 0, takeIndex: 0 },
          { startPpq: 2, takeIndex: 1 },
        ]),
      recInfo.clipId,
    );
    const compHead = (await probeWindow(0, 2)).peakDb;
    const compTail = (await probeWindow(2, 4)).peakDb;
    if (!(compHead - compTail > 10 && compHead - compTail < 14)) {
      fail(
        `comp segments not audible in export: head ${compHead.toFixed(1)} dB, ` +
          `tail ${compTail.toFixed(1)} dB`,
      );
    }

    await page.evaluate((clipId) => window.__sonareDebug.flattenClipComp(clipId), recInfo.clipId);
    const flatInfo = (
      await page.evaluate((id) => window.__sonareDebug.clipTakesInfo(id), recTrackId)
    )[0];
    const flatHead = (await probeWindow(0, 2)).peakDb;
    const flatTail = (await probeWindow(2, 4)).peakDb;
    if (
      flatInfo.takeCount !== 0 ||
      Math.abs(flatHead - compHead) > 1 ||
      Math.abs(flatTail - compTail) > 1
    ) {
      fail(
        `flatten changed the comp: ${flatInfo.takeCount} takes left, head ` +
          `${flatHead.toFixed(1)} dB (was ${compHead.toFixed(1)}), tail ` +
          `${flatTail.toFixed(1)} dB (was ${compTail.toFixed(1)})`,
      );
    } else {
      console.info(
        `PASS cycle recording: ${recInfo.takeCount} takes, take switch ` +
          `${(takeA - takeB).toFixed(1)} dB, comp head/tail ${compHead.toFixed(1)}/` +
          `${compTail.toFixed(1)} dB, flatten preserved ${flatHead.toFixed(1)}/${flatTail.toFixed(1)} dB`,
      );
    }

    await page.evaluate(
      ([id, others]) => {
        window.__sonareDebug.armTrack(null);
        for (const other of others) window.__sonareDebug.removeAutomationLane(other, 'faderDb');
        window.__sonareDebug.setLoopRange(0, 4, false);
        window.__sonareDebug.removeTrack(id);
      },
      [recTrackId, otherIds],
    );
  }

  // --- Group routing & sidechain ducking ---------------------------------------

  {
    // Pad spans ppq 0..8, kick ppq 0..4: with the kick keying a ducking
    // insert on the pad, the pad's exported level in the kick window must sit
    // far below its level after the kick ends — and the kick can stay silent
    // in the mix (the key taps pre-fader audio).
    const ids = await page.evaluate(async () => {
      const pad = window.__sonareDebug.addAudioTrack('Pad');
      const kick = window.__sonareDebug.addAudioTrack('Kick');
      await window.__sonareDebug.addToneClip(pad, 4.0, 220, 0.5, 0);
      await window.__sonareDebug.addToneClip(kick, 2.0, 80, 0.9, 0);
      const others = window.__sonareDebug.trackIds().filter((id) => id !== pad);
      for (const id of others) {
        window.__sonareDebug.setAutomationLanePoints(id, 'faderDb', [
          { ppq: 0, value: -120, curve: 'hold' },
        ]);
      }
      window.__sonareDebug.addTrackInsert(pad, 'dynamics.duckingProcessor', {
        thresholdDb: -30,
        ratio: 20,
        attackMs: 1,
        releaseMs: 50,
        rangeDb: 24,
      });
      window.__sonareDebug.setInsertSidechain(pad, 0, kick);
      return { pad, kick, others };
    });
    const probe = (startPpq, endPpq) =>
      page.evaluate((range) => window.__sonareDebug.exportProbe(false, range), {
        startPpq,
        endPpq,
      });
    const ducked = (await probe(1, 3)).peakDb;
    const open = (await probe(5, 7)).peakDb;
    if (!(open - ducked > 12)) {
      fail(
        `sidechain ducking not rendered: kick window ${ducked.toFixed(1)} dB vs ` +
          `open window ${open.toFixed(1)} dB`,
      );
    }

    // Group routing: moving the pad into a group is transparent at unity and
    // the group strip gain then attenuates it by the set amount.
    const groupId = await page.evaluate((pad) => {
      const group = window.__sonareDebug.addGroupTrack('Pads');
      window.__sonareDebug.setTrackGroup(pad, group);
      return group;
    }, ids.pad);
    const grouped = (await probe(5, 7)).peakDb;
    await page.evaluate((group) => window.__sonareDebug.setStripGainDb(group, -12), groupId);
    const groupAttenuated = (await probe(5, 7)).peakDb;
    if (Math.abs(grouped - open) > 1 || Math.abs(grouped - 12 - groupAttenuated) > 1.5) {
      fail(
        `group routing wrong: ungrouped ${open.toFixed(1)} dB, grouped ${grouped.toFixed(1)} dB, ` +
          `group -12 dB -> ${groupAttenuated.toFixed(1)} dB`,
      );
    } else {
      console.info(
        `PASS group/sidechain: ducked ${ducked.toFixed(1)} dB vs open ${open.toFixed(1)} dB, ` +
          `grouped ${grouped.toFixed(1)} dB, group -12 dB -> ${groupAttenuated.toFixed(1)} dB`,
      );
    }

    // Live parity: the pad lane meter while the kick window plays must sit
    // well below its level in the open window.
    await page.evaluate(() => window.__sonareDebug.setLoopRange(0, 8, true));
    await page.evaluate(() => window.__sonareDebug.seekPpq(0));
    await page.click('.transport-bar button:has-text("Play")');
    const sampleTrackWindow = async (fromPpq, toPpq) => {
      let peak = Number.NEGATIVE_INFINITY;
      const deadline = Date.now() + 9000;
      while (Date.now() < deadline) {
        const pos = await page.evaluate(() => window.__sonareDebug.positionPpq());
        if (pos >= fromPpq && pos <= toPpq) {
          const level = await page.evaluate((id) => window.__sonareDebug.trackMeterDb(id), ids.pad);
          if (level !== null && level > peak) peak = level;
        }
        if (pos > toPpq) break;
        await page.waitForTimeout(80);
      }
      return peak;
    };
    const liveDucked = await sampleTrackWindow(1, 3);
    const liveOpen = await sampleTrackWindow(5, 7);
    await page.click('.transport-bar button:has-text("Stop")');
    if (!Number.isFinite(liveDucked) || !Number.isFinite(liveOpen) || liveOpen - liveDucked < 10) {
      fail(
        `live sidechain ducking diverges: kick window ${liveDucked.toFixed(1)} dB, ` +
          `open window ${liveOpen.toFixed(1)} dB`,
      );
    } else {
      console.info(
        `PASS live ducking: kick window ${liveDucked.toFixed(1)} dB vs open ` +
          `${liveOpen.toFixed(1)} dB`,
      );
    }

    await page.evaluate(
      ([pad, kick, group, others]) => {
        window.__sonareDebug.setLoopRange(0, 8, false);
        for (const id of others) window.__sonareDebug.removeAutomationLane(id, 'faderDb');
        window.__sonareDebug.removeTrack(group);
        window.__sonareDebug.removeTrack(kick);
        window.__sonareDebug.removeTrack(pad);
      },
      [ids.pad, ids.kick, groupId, ids.others],
    );
  }

  // --- Tempo-following clips (warp) -------------------------------------------

  {
    // A 4-beat click track recorded at 120 bpm: with warp enabled the clicks
    // must land on the beat grid after the project tempo changes to 90, and
    // fall off it once warp is disabled (the audio then plays at its
    // recorded rate).
    const warp = await page.evaluate(async () => {
      const id = window.__sonareDebug.addAudioTrack('Warp');
      const clipId = await window.__sonareDebug.addClickClip(id, 4, 120, 0);
      const others = window.__sonareDebug.trackIds().filter((other) => other !== id);
      for (const other of others) {
        window.__sonareDebug.setAutomationLanePoints(other, 'faderDb', [
          { ppq: 0, value: -120, curve: 'hold' },
        ]);
      }
      window.__sonareDebug.setClipWarp(clipId, { enabled: true, sourceBpm: 120 });
      window.__sonareDebug.setTempoSegments([{ startPpq: 0, bpm: 90 }]);
      return { id, clipId, others };
    });
    const probe = (startPpq, endPpq) =>
      page.evaluate((range) => window.__sonareDebug.exportProbe(false, range), {
        startPpq,
        endPpq,
      });
    // At 90 bpm a beat is ~667 ms; the 10 ms clicks sit at the very start of
    // each beat. Probe a window over beat 2's click and the gap after it.
    const onBeat = (await probe(1.98, 2.2)).peakDb;
    const offBeat = (await probe(2.3, 2.9)).peakDb;
    await page.evaluate((clipId) => window.__sonareDebug.setClipWarp(clipId, null), warp.clipId);
    const unwarped = (await probe(1.98, 2.2)).peakDb;
    // Unwarped at 90 bpm, the clicks land at source seconds 0/0.5/1/1.5 =
    // ppq 0/0.75/1.5/2.25 — outside the probed on-beat window.
    if (!(onBeat > -20) || !(offBeat < -50) || !(unwarped < -50)) {
      fail(
        `tempo follow not rendered: on-beat ${onBeat.toFixed(1)} dB, off-beat ` +
          `${offBeat.toFixed(1)} dB, unwarped on-beat ${unwarped.toFixed(1)} dB`,
      );
    } else {
      console.info(
        `PASS tempo follow: on-beat ${onBeat.toFixed(1)} dB, off-beat ${offBeat.toFixed(1)} dB, ` +
          `unwarped on-beat ${unwarped.toFixed(1)} dB`,
      );
    }
    await page.evaluate(
      ([id, others]) => {
        window.__sonareDebug.setTempoSegments([{ startPpq: 0, bpm: 120 }]);
        for (const other of others) window.__sonareDebug.removeAutomationLane(other, 'faderDb');
        window.__sonareDebug.removeTrack(id);
      },
      [warp.id, warp.others],
    );
  }

  // --- Track freeze & bounce-in-place ------------------------------------------

  {
    // Freeze bakes a track's pre-fader render: the master measurement must
    // match before/after, edits while frozen must stay silent, and unfreeze
    // must bring them back. Bounce-in-place adds the rendered range as a new
    // clip while the original keeps playing.
    const fz = await page.evaluate(async () => {
      const id = window.__sonareDebug.addAudioTrack('Freeze');
      const clipId = await window.__sonareDebug.addToneClip(id, 2.0, 440, 0.5, 0);
      const others = window.__sonareDebug.trackIds().filter((other) => other !== id);
      for (const other of others) {
        window.__sonareDebug.setAutomationLanePoints(other, 'faderDb', [
          { ppq: 0, value: -120, curve: 'hold' },
        ]);
      }
      return { id, clipId, others };
    });
    const probe = (startPpq, endPpq) =>
      page.evaluate((range) => window.__sonareDebug.exportProbe(false, range), {
        startPpq,
        endPpq,
      });
    const before = (await probe(0, 4)).peakDb;
    await page.evaluate((id) => window.__sonareDebug.freezeTrack(id), fz.id);
    const frozenStates = await page.evaluate(() => window.__sonareDebug.trackFrozenStates());
    const after = (await probe(0, 4)).peakDb;
    await page.evaluate((clipId) => window.__sonareDebug.removeClip(clipId), fz.clipId);
    const editedFrozen = (await probe(0, 4)).peakDb;
    await page.evaluate((id) => window.__sonareDebug.unfreezeTrack(id), fz.id);
    const unfrozen = (await probe(0, 4)).peakDb;
    if (
      !frozenStates.some((state) => state !== null) ||
      Math.abs(before - after) > 1 ||
      Math.abs(before - editedFrozen) > 1 ||
      !(unfrozen < -60)
    ) {
      fail(
        `freeze parity broken: before ${before.toFixed(1)} dB, frozen ${after.toFixed(1)} dB, ` +
          `edited-while-frozen ${editedFrozen.toFixed(1)} dB, unfrozen ${unfrozen.toFixed(1)} dB`,
      );
    } else {
      console.info(
        `PASS freeze: before ${before.toFixed(1)} dB, frozen ${after.toFixed(1)} dB, ` +
          `edited-while-frozen ${editedFrozen.toFixed(1)} dB, unfrozen ${unfrozen.toFixed(1)} dB`,
      );
    }

    // Bounce-in-place: re-add a tone, bounce its first half onto a new track
    // and verify the doubled level in the bounced range only.
    const bounce = await page.evaluate(async (id) => {
      const clipId = await window.__sonareDebug.addToneClip(id, 2.0, 440, 0.5, 0);
      const beforeIds = window.__sonareDebug.trackIds();
      const bounced = await window.__sonareDebug.bounceTrackRange(id, 0, 2);
      const newTrack = window.__sonareDebug
        .trackIds()
        .find((candidate) => !beforeIds.includes(candidate));
      return { clipId, bounced, newTrack };
    }, fz.id);
    const doubled = (await probe(0, 2)).peakDb;
    const single = (await probe(2, 4)).peakDb;
    if (!(doubled > single + 4 && doubled < single + 8)) {
      fail(
        `bounce-in-place wrong: bounced range ${doubled.toFixed(1)} dB vs original-only ` +
          `${single.toFixed(1)} dB (expected ~+6 dB)`,
      );
    } else {
      console.info(
        `PASS bounce-in-place: bounced range ${doubled.toFixed(1)} dB vs original-only ` +
          `${single.toFixed(1)} dB`,
      );
    }
    await page.evaluate(
      ([id, newTrack, others]) => {
        if (newTrack !== undefined && newTrack !== null) {
          window.__sonareDebug.removeTrack(newTrack);
        }
        for (const other of others) window.__sonareDebug.removeAutomationLane(other, 'faderDb');
        window.__sonareDebug.removeTrack(id);
      },
      [fz.id, bounce.newTrack ?? null, fz.others],
    );
  }

  // --- Mastering tab: add processors to the project mastering chain -----------

  await page.click('.dock-tabs button:has-text("Mastering")');
  await page.waitForSelector('.mastering-panel .chain-add', { timeout: 10000 });
  // A brickwall limiter (rack add flow), plus tape saturation whose defaults
  // are audibly non-transparent so the chain provably changes the mixdown.
  for (const processorLabel of [/^Brickwall Limiter$/, /^Tape$/]) {
    await page.click('.mastering-panel .chain-add');
    await page.waitForSelector('.chain-catalog .catalog-item', { timeout: 10000 });
    await page
      .locator('.chain-catalog .catalog-item')
      .filter({ hasText: processorLabel })
      .first()
      .click();
  }
  const masteringChain = await page.evaluate(() => window.__sonareDebug.masteringProcessors());
  if (
    masteringChain.length !== 2 ||
    !masteringChain.includes('dynamics.brickwallLimiter') ||
    !masteringChain.includes('saturation.tape')
  ) {
    fail(`unexpected mastering chain: ${JSON.stringify(masteringChain)}`);
  } else {
    console.info(`mastering chain set: ${masteringChain.join(', ')}`);
  }

  // Real-wasm export probe: the worker render must be non-silent and the
  // master chain must change the encoded bytes. The first call initializes
  // the wasm inside the export worker.
  const probeOn = await page.evaluate(() => window.__sonareDebug.exportProbe(true));
  const probeOff = await page.evaluate(() => window.__sonareDebug.exportProbe(false));
  if (probeOn.riff !== 'RIFF' || probeOn.totalFrames <= 0 || !(probeOn.peakDb > -40)) {
    fail(`export probe not an audible WAV: ${JSON.stringify(probeOn)}`);
  } else if (probeOn.hash === probeOff.hash) {
    fail(`mastering chain has no effect on export bytes: ${probeOn.hash}`);
  } else {
    console.info(
      `export probe: peak ${probeOn.peakDb.toFixed(1)} dBFS, chain on/off bytes differ ` +
        `(${probeOn.hash} vs ${probeOff.hash})`,
    );
  }

  // --- Export dialog: WAV 16-bit mixdown download -----------------------------

  await page.click('.app-menubar__trigger:has-text("File")');
  await page
    .locator('.menu-panel [role="menuitem"]')
    .filter({ hasText: /^Export Audio…$/ })
    .click();
  await page.waitForSelector('.dialog .export-button:not([disabled])', { timeout: 10000 });
  // Defaults are WAV / 16-bit / 48 kHz / whole project / master chain on.
  await page.click('.dialog .export-button');
  await page.waitForSelector('.dialog .export-report', { timeout: 120000 });
  const reportPeakText = ((await page.locator('.dialog .report-peak').textContent()) ?? '').trim();
  const reportPeakDb = Number.parseFloat(reportPeakText);
  if (!Number.isFinite(reportPeakDb) || reportPeakDb <= -40) {
    fail(`loudness report peak not audible: "${reportPeakText}"`);
  } else {
    console.info(`export dialog loudness report rendered: peak ${reportPeakText}`);
  }

  // The shell's download seam records the last file; parse the WAV in-page.
  const wavInfo = await page.evaluate(async () => {
    const download = window.__sonareDebug.lastDownload();
    if (!download) return null;
    const bytes = new Uint8Array(await download.blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const tag = (off) => String.fromCharCode(...bytes.subarray(off, off + 4));
    let offset = 12;
    let dataOffset = -1;
    let dataLength = 0;
    while (offset + 8 <= bytes.length) {
      const id = tag(offset);
      const length = view.getUint32(offset + 4, true);
      if (id === 'data') {
        dataOffset = offset + 8;
        dataLength = length;
        break;
      }
      offset += 8 + length + (length % 2);
    }
    let peak = 0;
    for (let i = dataOffset; i + 1 < dataOffset + dataLength; i += 2) {
      const sample = Math.abs(view.getInt16(i, true)) / 32768;
      if (sample > peak) peak = sample;
    }
    return {
      filename: download.filename,
      byteLength: bytes.length,
      riff: tag(0),
      wave: tag(8),
      dataOffset,
      dataLength,
      peak,
    };
  });
  if (!wavInfo) {
    fail('no download captured for the audio export');
  } else if (
    wavInfo.riff !== 'RIFF' ||
    wavInfo.wave !== 'WAVE' ||
    !wavInfo.filename.endsWith('.wav')
  ) {
    fail(`exported file is not a WAV: ${JSON.stringify(wavInfo)}`);
  } else if (
    wavInfo.dataOffset < 0 ||
    wavInfo.dataLength <= 0 ||
    wavInfo.dataOffset + wavInfo.dataLength > wavInfo.byteLength
  ) {
    fail(`exported WAV data chunk is implausible: ${JSON.stringify(wavInfo)}`);
  } else if (!(20 * Math.log10(wavInfo.peak) > -40)) {
    fail(`exported WAV is too quiet: peak ${wavInfo.peak}`);
  } else {
    console.info(
      `exported WAV verified: ${wavInfo.filename}, ${wavInfo.byteLength} bytes, ` +
        `data ${wavInfo.dataLength} bytes, peak ${(20 * Math.log10(wavInfo.peak)).toFixed(1)} dBFS`,
    );
  }
  await page.click('.dialog .close-button');

  // --- MIDI export: SMF + MIDI 2.0 clip-file downloads ------------------------

  await page.click('.app-menubar__trigger:has-text("File")');
  await page
    .locator('.menu-panel [role="menuitem"]')
    .filter({ hasText: /^Export SMF$/ })
    .click();
  await page.waitForFunction(
    () => window.__sonareDebug.lastDownload()?.filename.endsWith('.mid') === true,
    null,
    { timeout: 60000 },
  );
  const smfInfo = await page.evaluate(async () => {
    const download = window.__sonareDebug.lastDownload();
    const bytes = new Uint8Array(await download.blob.arrayBuffer());
    const tag = (off, length = 4) => String.fromCharCode(...bytes.subarray(off, off + length));
    return {
      filename: download.filename,
      byteLength: bytes.length,
      header: tag(0),
    };
  });
  if (smfInfo.header !== 'MThd' || smfInfo.byteLength <= 14) {
    fail(`SMF download is not a valid MIDI header: ${JSON.stringify(smfInfo)}`);
  } else {
    console.info(`SMF exported: ${smfInfo.filename}, ${smfInfo.byteLength} bytes`);
  }

  await page.click('.app-menubar__trigger:has-text("File")');
  await page
    .locator('.menu-panel [role="menuitem"]')
    .filter({ hasText: /^Export MIDI 2\.0 clip file$/ })
    .click();
  await page.waitForFunction(
    () => window.__sonareDebug.lastDownload()?.filename.endsWith('.midi2') === true,
    null,
    { timeout: 60000 },
  );
  const midi2Info = await page.evaluate(async () => {
    const download = window.__sonareDebug.lastDownload();
    const bytes = new Uint8Array(await download.blob.arrayBuffer());
    const tag = (off, length = 4) => String.fromCharCode(...bytes.subarray(off, off + length));
    return {
      filename: download.filename,
      byteLength: bytes.length,
      header: tag(0),
    };
  });
  if (midi2Info.header !== 'SMF2' || midi2Info.byteLength <= 4) {
    fail(`MIDI 2.0 clip-file download is not valid: ${JSON.stringify(midi2Info)}`);
  } else {
    console.info(
      `MIDI 2.0 clip file exported: ${midi2Info.filename}, ${midi2Info.byteLength} bytes`,
    );
  }

  // --- DAWproject export: zip magic + project.xml entry ------------------------

  await page.click('.app-menubar__trigger:has-text("File")');
  await page
    .locator('.menu-panel [role="menuitem"]')
    .filter({ hasText: /^Export DAWproject$/ })
    .click();
  await page.waitForFunction(
    () => window.__sonareDebug.lastDownload()?.filename.endsWith('.dawproject') === true,
    null,
    { timeout: 60000 },
  );
  const dawDownload = await page.evaluate(async () => {
    const download = window.__sonareDebug.lastDownload();
    const bytes = new Uint8Array(await download.blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { filename: download.filename, base64: btoa(binary) };
  });
  const dawBytes = new Uint8Array(Buffer.from(dawDownload.base64, 'base64'));
  if (
    dawBytes[0] !== 0x50 ||
    dawBytes[1] !== 0x4b ||
    dawBytes[2] !== 0x03 ||
    dawBytes[3] !== 0x04
  ) {
    fail(`DAWproject download is not a zip: ${dawBytes.slice(0, 4)}`);
  } else {
    const entries = unzipSync(dawBytes);
    const names = Object.keys(entries);
    const projectXml = entries['project.xml']
      ? Buffer.from(entries['project.xml']).toString('utf8')
      : '';
    if (!projectXml.includes('<Project')) {
      fail(`DAWproject zip is missing a project.xml document: entries ${names.join(', ')}`);
    } else if (!entries['metadata.xml']) {
      fail(`DAWproject zip is missing metadata.xml: entries ${names.join(', ')}`);
    } else {
      console.info(
        `DAWproject exported: ${dawDownload.filename}, ${dawBytes.length} bytes, ` +
          `entries [${names.join(', ')}]`,
      );
    }
  }

  if (process.exitCode !== 1) console.info('E2E SMOKE PASS');
} catch (err) {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  await browser.close();
}
