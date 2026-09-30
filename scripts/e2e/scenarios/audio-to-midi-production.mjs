import { downloadBytes, inspectWav } from '../wav-inspection.mjs';

/** Walk the complete audio-to-MIDI production path in an isolated browser context. */
export const name = 'audio-to-midi-production';

const PROJECT_NAME = 'e2e-audio-to-midi-production';
const AUDIO_FILE_NAME = 'production-c4-e4-g4-melody.wav';
const SAMPLE_RATE = 22050;
const PHRASE = [
  { frequency: 261.625565, start: 0, end: 0.36, pitch: 60 },
  { frequency: 329.627557, start: 0.48, end: 0.84, pitch: 64 },
  { frequency: 391.995436, start: 0.96, end: 1.32, pitch: 67 },
];
const SOURCE_SECONDS = 1.5;
const SYNTH_PRESET = 'saw-lead';

/** A short, deterministic C4/E4/G4 melody with click-free edges and gaps. */
function melodyWavBytes() {
  const frames = Math.round(SOURCE_SECONDS * SAMPLE_RATE);
  const data = Buffer.alloc(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const seconds = frame / SAMPLE_RATE;
    const note = PHRASE.find((candidate) => seconds >= candidate.start && seconds < candidate.end);
    const localSeconds = note ? seconds - note.start : 0;
    const remainingSeconds = note ? note.end - seconds : 0;
    const attack = Math.min(1, localSeconds / 0.025);
    const release = Math.min(1, remainingSeconds / 0.04);
    const envelope = note ? Math.max(0, Math.min(attack, release)) : 0;
    const sample = note
      ? 0.35 * envelope * Math.sin((2 * Math.PI * note.frequency * frame) / SAMPLE_RATE)
      : 0;
    data.writeInt16LE(Math.round(sample * 32767), frame * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function readVlq(bytes, offset, end) {
  let value = 0;
  for (let count = 0; count < 4; count += 1) {
    if (offset >= end) throw new Error('truncated SMF variable-length value');
    const byte = bytes[offset++];
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, offset };
  }
  throw new Error('SMF variable-length value exceeds four bytes');
}

/** Parse absolute SMF note spans from the actual download, including pairing. */
function parseSmfNotes(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length < 14 || bytes.toString('ascii', 0, 4) !== 'MThd') {
    throw new Error('SMF download has no MThd header');
  }
  const headerLength = bytes.readUInt32BE(4);
  if (headerLength < 6 || 8 + headerLength > bytes.length) {
    throw new Error(`invalid SMF header length ${headerLength}`);
  }
  const division = bytes.readUInt16BE(12);
  if (division === 0 || (division & 0x8000) !== 0) {
    throw new Error(`SMF uses an unsupported time division ${division}`);
  }
  const trackCount = bytes.readUInt16BE(10);
  let offset = 8 + headerLength;
  const notes = [];
  for (let track = 0; track < trackCount; track += 1) {
    if (offset + 8 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'MTrk') {
      throw new Error(`SMF track ${track} is missing its MTrk header`);
    }
    const length = bytes.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) throw new Error(`SMF track ${track} is truncated`);
    offset = end;
    let cursor = start;
    let runningStatus = 0;
    let absoluteTick = 0;
    const active = new Map();
    const closeNote = (channel, pitch) => {
      const key = `${channel}:${pitch}`;
      const queue = active.get(key);
      if (!queue || queue.length === 0) {
        throw new Error(`SMF track ${track} has note-off without note-on for ${key}`);
      }
      const opening = queue.shift();
      notes.push({
        channel,
        pitch,
        startTick: opening.startTick,
        durationTicks: absoluteTick - opening.startTick,
      });
      if (queue.length === 0) active.delete(key);
    };
    while (cursor < end) {
      const delta = readVlq(bytes, cursor, end);
      absoluteTick += delta.value;
      cursor = delta.offset;
      if (cursor >= end) throw new Error(`SMF track ${track} ends after a delta time`);
      let status = bytes[cursor++];
      if (status < 0x80) {
        if (runningStatus === 0) throw new Error(`SMF track ${track} has no running status`);
        cursor -= 1;
        status = runningStatus;
      } else if (status < 0xf0) {
        runningStatus = status;
      }

      if (status === 0xff) {
        if (cursor >= end) throw new Error(`SMF track ${track} has a truncated meta event`);
        const metaType = bytes[cursor++];
        const meta = readVlq(bytes, cursor, end);
        cursor = meta.offset + meta.value;
        if (cursor > end) throw new Error(`SMF track ${track} meta event is truncated`);
        runningStatus = 0;
        if (metaType === 0x2f) break;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const sysex = readVlq(bytes, cursor, end);
        cursor = sysex.offset + sysex.value;
        if (cursor > end) throw new Error(`SMF track ${track} SysEx is truncated`);
        runningStatus = 0;
        continue;
      }

      if (status >= 0xf0) {
        const dataLength = status === 0xf1 || status === 0xf3 ? 1 : status === 0xf2 ? 2 : 0;
        if (cursor + dataLength > end) {
          throw new Error(`SMF track ${track} has a truncated system event`);
        }
        cursor += dataLength;
        runningStatus = 0;
        continue;
      }

      const channel = status & 0x0f;
      const kind = status & 0xf0;
      if (kind === 0xc0 || kind === 0xd0) {
        if (cursor >= end) throw new Error(`SMF track ${track} has a truncated channel event`);
        cursor += 1;
        continue;
      }
      if (cursor + 2 > end) throw new Error(`SMF track ${track} has a truncated channel event`);
      const pitch = bytes[cursor++];
      const velocity = bytes[cursor++];
      if (kind === 0x90 && velocity > 0) {
        const key = `${channel}:${pitch}`;
        const queue = active.get(key) ?? [];
        queue.push({ startTick: absoluteTick });
        active.set(key, queue);
      } else if (kind === 0x80 || (kind === 0x90 && velocity === 0)) {
        closeNote(channel, pitch);
      }
    }
    if (active.size > 0) {
      throw new Error(
        `SMF track ${track} ended with ${[...active.values()].flat().length} open note(s)`,
      );
    }
  }
  return {
    division,
    notes: notes.sort(
      (left, right) =>
        left.startTick - right.startTick ||
        left.pitch - right.pitch ||
        left.channel - right.channel,
    ),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sortNotes(notes) {
  return [...notes].sort(
    (left, right) =>
      left.startPpq - right.startPpq ||
      left.pitch - right.pitch ||
      left.durationPpq - right.durationPpq,
  );
}

function noteMatches(left, right) {
  return (
    left.pitch === right.pitch &&
    Math.abs(left.startPpq - right.startPpq) < 1e-6 &&
    Math.abs(left.durationPpq - right.durationPpq) < 1e-6
  );
}

function rmsWindow(wav, startSeconds, endSeconds) {
  const start = Math.max(0, Math.floor(startSeconds * wav.sampleRate));
  const end = Math.min(wav.frames, Math.ceil(endSeconds * wav.sampleRate));
  if (end <= start) return 0;
  let energy = 0;
  for (let frame = start; frame < end; frame += 1) {
    for (let channel = 0; channel < wav.channels; channel += 1) {
      const sample = wav.samples[frame * wav.channels + channel] ?? 0;
      energy += sample * sample;
    }
  }
  return Math.sqrt(energy / ((end - start) * wav.channels));
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

async function startEmptyProject(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.locator('[data-testid="start-new"]').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('[data-testid="start-new"]').click();
  await page.locator('#new-project-template-empty').click();
  await page
    .locator('.modal-card:has(#new-project-template-empty) .modal-foot button.primary')
    .click();
  await skipTour(page);
  await page.waitForFunction(() => window.__sonareDebug?.initialized() === true, null, {
    timeout: 30000,
  });
}

async function selectClip(page, clipId) {
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), clipId);
  await page.waitForFunction((id) => window.__sonareDebug.activeClipId() === id, clipId, {
    timeout: 15000,
  });
}

async function importMelody(page) {
  await page
    .locator('.dock-tabs button')
    .filter({ hasText: /^Media$/ })
    .click();
  const before = await page.evaluate(() => window.__sonareDebug.clipRanges());
  await page.setInputFiles('.media-browser .file-input', {
    name: AUDIO_FILE_NAME,
    mimeType: 'audio/wav',
    buffer: melodyWavBytes(),
  });
  const asset = page
    .locator('.media-browser .asset-row')
    .filter({ hasText: 'production-c4-e4-g4-melody' })
    .last();
  await asset.waitFor({ state: 'visible', timeout: 20000 });
  await asset.locator('.add-button').click();
  await page.waitForFunction(
    ({ clipCount, audioCount }) =>
      window.__sonareDebug.clipCount() === clipCount + 1 &&
      window.__sonareDebug.audioClipCount() === audioCount + 1,
    {
      clipCount: before.length,
      audioCount: before.filter((clip) => clip.kind === 'audio').length,
    },
    { timeout: 20000 },
  );
  const after = await page.evaluate(() => window.__sonareDebug.clipRanges());
  const clip = after.find((entry) => !before.some((existing) => existing.id === entry.id));
  assert(clip?.kind === 'audio', `audio fixture was not imported: ${JSON.stringify(clip)}`);
  await selectClip(page, clip.id);
  return clip;
}

async function transcribeMelody(page, sourceClip) {
  await selectClip(page, sourceClip.id);
  const processButton = page.locator('.arrangement-process-controls button', {
    hasText: /^To MIDI$/,
  });
  await processButton.waitFor({ state: 'visible' });
  await processButton.click();
  const dialog = page.getByRole('dialog', { name: 'Transcribe audio to MIDI' });
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  const melodyMode = dialog.getByRole('radio', { name: /Melody/ });
  await melodyMode.click();
  const before = await page.evaluate(() => ({
    clips: window.__sonareDebug.clipRanges(),
    tracks: window.__sonareDebug.trackCount(),
  }));
  await dialog.getByRole('button', { name: 'Transcribe', exact: true }).click();
  await page.waitForFunction(
    ({ clipCount, trackCount }) =>
      !document.querySelector('.modal-card[aria-label="Transcribe audio to MIDI"]') &&
      window.__sonareDebug.clipCount() === clipCount + 1 &&
      window.__sonareDebug.trackCount() === trackCount + 1,
    { clipCount: before.clips.length, trackCount: before.tracks },
    { timeout: 60000 },
  );
  const after = await page.evaluate(() => window.__sonareDebug.clipRanges());
  const midiClip = after.find(
    (entry) => entry.kind === 'midi' && !before.clips.some((existing) => existing.id === entry.id),
  );
  assert(midiClip, `mono transcription did not create a MIDI clip: ${JSON.stringify(after)}`);
  await selectClip(page, midiClip.id);
  const notes = sortNotes(await page.evaluate(() => window.__sonareDebug.activeNotes()));
  const pitches = notes.map((note) => note.pitch);
  assert(
    notes.length === PHRASE.length &&
      JSON.stringify(pitches) === JSON.stringify(PHRASE.map((note) => note.pitch)),
    `mono transcription should create C4/E4/G4: ${JSON.stringify({ notes, pitches })}`,
  );
  return { midiClip, notes };
}

async function openPianoRoll(page, clipId) {
  await selectClip(page, clipId);
  await page
    .locator('.dock-tabs button')
    .filter({ hasText: /^Piano Roll$/ })
    .click();
  await page.locator('.note-grid canvas').first().waitFor({ state: 'visible', timeout: 15000 });
  const fitNotes = page.locator('.zoom-cluster .fit-btn').nth(1);
  if (await fitNotes.isVisible()) await fitNotes.click();
}

async function notePoint(page, note, pitch = note.pitch) {
  return page.evaluate(
    ({ note: target, pitch: targetPitch }) => {
      const grid = document.querySelector('.note-grid');
      const props = grid?.__vueParentComponent?.props;
      if (!grid || !props?.range) throw new Error('piano-roll range is unavailable');
      const rect = grid.getBoundingClientRect();
      const localX = props.range.ppqToX(target.startPpq + target.durationPpq / 2);
      const localY = props.range.pitchToY(targetPitch) + props.range.rowHeight / 2;
      if (localY < 4 || localY > rect.height - 4) {
        throw new Error(`pitch ${targetPitch} is outside the visible piano roll`);
      }
      return {
        x: rect.left + Math.max(4, Math.min(rect.width - 4, localX)),
        y: rect.top + localY,
      };
    },
    { note, pitch },
  );
}

async function correctOneNote(page, generatedNotes) {
  await openPianoRoll(page, generatedNotes.clipId);
  const orderedNotes = sortNotes(generatedNotes.notes);
  const originalNote = orderedNotes[0];
  const preservedNotes = orderedNotes.slice(1);
  const correctedPitch = originalNote.pitch < 127 ? originalNote.pitch + 1 : originalNote.pitch - 1;
  await page.locator('.tool-palette .tool-button').nth(0).click();
  const originalPoint = await notePoint(page, originalNote);
  await page.mouse.click(originalPoint.x, originalPoint.y);
  await page.waitForFunction(() => window.__sonareDebug.selectionCount() === 1, null, {
    timeout: 10000,
  });
  await page.locator('.piano-roll-editor').focus();
  await page.keyboard.press('Delete');
  await page.waitForFunction(
    (expected) => {
      const notes = window.__sonareDebug.activeNotes();
      return (
        notes.length === expected.length &&
        expected.every((target) =>
          notes.some(
            (note) =>
              note.pitch === target.pitch &&
              Math.abs(note.startPpq - target.startPpq) < 1e-6 &&
              Math.abs(note.durationPpq - target.durationPpq) < 1e-6,
          ),
        )
      );
    },
    preservedNotes,
    { timeout: 15000 },
  );

  await page.locator('.tool-palette .tool-button').nth(1).click();
  const drawPoint = await page.evaluate(
    ({ pitch, startPpq }) => {
      const grid = document.querySelector('.note-grid');
      const props = grid?.__vueParentComponent?.props;
      if (!grid || !props?.range) throw new Error('piano-roll range is unavailable for drawing');
      const rect = grid.getBoundingClientRect();
      const localY = props.range.pitchToY(pitch) + props.range.rowHeight / 2;
      if (localY < 4 || localY > rect.height - 4) {
        throw new Error(`corrected pitch ${pitch} is outside the visible piano roll`);
      }
      // Keep the pointer comfortably inside the first visible cell. The draw
      // tool snaps this to the current grid and creates one cell of duration.
      const localX = Math.max(12, Math.min(rect.width - 12, props.range.ppqToX(startPpq + 0.125)));
      return { x: rect.left + localX, y: rect.top + localY };
    },
    { pitch: correctedPitch, startPpq: originalNote.startPpq },
  );
  await page.mouse.click(drawPoint.x, drawPoint.y);
  await page.waitForFunction(
    ({ pitch, preserved }) => {
      const notes = window.__sonareDebug.activeNotes();
      return (
        notes.length === preserved.length + 1 &&
        notes.some((note) => note.pitch === pitch) &&
        preserved.every((target) =>
          notes.some(
            (note) =>
              note.pitch === target.pitch &&
              Math.abs(note.startPpq - target.startPpq) < 1e-6 &&
              Math.abs(note.durationPpq - target.durationPpq) < 1e-6,
          ),
        )
      );
    },
    { pitch: correctedPitch, preserved: preservedNotes },
    { timeout: 15000 },
  );
  const corrected = sortNotes(await page.evaluate(() => window.__sonareDebug.activeNotes()));
  const expectedPitches = [correctedPitch, ...preservedNotes.map((note) => note.pitch)].sort(
    (left, right) => left - right,
  );
  const actualPitches = corrected.map((note) => note.pitch).sort((left, right) => left - right);
  assert(
    JSON.stringify(actualPitches) === JSON.stringify(expectedPitches) &&
      preservedNotes.every((target) => corrected.some((note) => noteMatches(note, target))),
    `piano-roll correction did not preserve the other two notes: ${JSON.stringify({ corrected, expectedPitches })}`,
  );
  return corrected;
}

async function chooseSynthPreset(page, midiClipId) {
  await selectClip(page, midiClipId);
  const devicesToggle = page.locator('.app-bar .devices-toggle');
  const rack = page.locator('.device-rack');
  if (!(await rack.isVisible())) await devicesToggle.click();
  await rack.waitFor({ state: 'visible', timeout: 10000 });
  await rack.locator('.instrument-button').click();
  await page.locator('.instrument-picker .preset-option').first().waitFor({ state: 'visible' });
  const presetNames = await page.locator('.instrument-picker .preset-name').allTextContents();
  const preset = presetNames.includes(SYNTH_PRESET) ? SYNTH_PRESET : presetNames[0];
  assert(preset, 'built-in synth preset catalog is empty');
  await page
    .locator('.instrument-picker .preset-option')
    .filter({ has: page.locator(`.preset-name:text-is("${preset}")`) })
    .first()
    .click();
  await page.waitForFunction(
    (name) => window.__sonareDebug.trackInstruments().includes(name),
    preset,
    { timeout: 15000 },
  );
  return preset;
}

async function muteAudioTrack(page, audioClipId) {
  await selectClip(page, audioClipId);
  const header = page.locator('.track-header.active').first();
  await header.waitFor({ state: 'visible', timeout: 10000 });
  const mute = header.locator('.toggle.mute');
  await mute.waitFor({ state: 'visible' });
  if ((await mute.getAttribute('aria-pressed')) !== 'true') await mute.click();
  await page.waitForFunction(
    () =>
      document.querySelector('.track-header.active .toggle.mute')?.getAttribute('aria-pressed') ===
      'true',
    null,
    { timeout: 10000 },
  );
}

async function audition(page, midiClipId) {
  await selectClip(page, midiClipId);
  const before = await page.evaluate(() => window.__sonareDebug.positionPpq());
  const play = page.locator('.transport-key.play');
  await play.waitFor({ state: 'visible' });
  await play.click();
  await page.waitForFunction((start) => window.__sonareDebug.positionPpq() > start + 0.02, before, {
    timeout: 10000,
  });
  const after = await page.evaluate(() => window.__sonareDebug.positionPpq());
  await page.locator('.transport-key.stop').click();
  console.info(`transport clock advanced ${before.toFixed(3)} -> ${after.toFixed(3)} PPQ`);
  return { before, after };
}

async function saveAs(page) {
  await page.click('.app-menubar__trigger:has-text("File")');
  await page.locator('[id="menubar-file-file.saveAs"]').click();
  const prompt = page.locator('.modal-card:has(.dialog-input)');
  await prompt.waitFor({ state: 'visible', timeout: 10000 });
  await prompt.locator('.dialog-input').fill(PROJECT_NAME);
  await prompt.locator('.modal-foot button.primary').click();
  await page.locator('.dirty-dot').waitFor({ state: 'detached', timeout: 30000 });
  await page.waitForFunction((name) => window.__sonareDebug.projectName() === name, PROJECT_NAME, {
    timeout: 30000,
  });
}

async function reopenSavedProject(page) {
  await page.reload({ waitUntil: 'load' });
  await page.locator('[data-testid="start-new"]').waitFor({ state: 'visible', timeout: 30000 });
  const saved = page.locator('.ss-project').filter({ hasText: PROJECT_NAME }).first();
  await saved.waitFor({ state: 'visible', timeout: 30000 });
  await saved.click();
  await page.waitForFunction(
    (name) =>
      window.__sonareDebug?.initialized() === true && window.__sonareDebug.projectName() === name,
    PROJECT_NAME,
    { timeout: 30000 },
  );
  await page
    .locator('.modal-scrim.is-launcher-layer')
    .waitFor({ state: 'detached', timeout: 15000 });
}

async function exportSmf(page) {
  await page.click('.app-menubar__trigger:has-text("File")');
  const item = page.locator('[id="menubar-file-file.exportSmf"]');
  await item.waitFor({ state: 'visible' });
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await item.click();
  const download = await downloadPromise;
  const bytes = await downloadBytes(download);
  const parsed = parseSmfNotes(bytes);
  assert(parsed.notes.length > 0, 'SMF download contained no paired note-on/off events');
  return { bytes, ...parsed, filename: download.suggestedFilename() };
}

async function exportWav(page, expectedDurationSeconds, notes) {
  await page.click('.app-menubar__trigger:has-text("File")');
  await page.locator('[id="menubar-file-file.exportAudio"]').click();
  const dialog = page.getByRole('dialog', { name: 'Export audio' });
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  const bitDepth = dialog.locator('.wav-bit-depth .select-trigger');
  await bitDepth.click();
  await page.locator('.select-list .select-option[data-value="32f"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector('.wav-bit-depth .select-value')?.textContent?.trim() ===
      '32-bit float',
    null,
    { timeout: 5000 },
  );
  const master = dialog.locator('.include-master-chain');
  if ((await master.getAttribute('aria-pressed')) === 'true') await master.click();
  assert(
    (await master.getAttribute('aria-pressed')) === 'false',
    'Export Audio master-chain toggle could not be turned off',
  );
  const releaseTail = dialog.locator('#export-release-tail');
  await releaseTail.fill('0');
  await releaseTail.press('Tab');
  assert((await releaseTail.inputValue()) === '0', 'Export Audio release tail did not become zero');
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
  await dialog.locator('.export-button').click();
  const download = await downloadPromise;
  const bytes = await downloadBytes(download);
  await dialog.locator('.close-button').waitFor({ state: 'visible', timeout: 30000 });
  await dialog.locator('.close-button').click();
  const wav = inspectWav(bytes);
  const durationError = Math.abs(wav.durationSeconds - expectedDurationSeconds);
  assert(
    durationError < 0.03,
    `WAV duration does not match the saved project range: ${JSON.stringify({ actual: wav.durationSeconds, expected: expectedDurationSeconds, durationError })}`,
  );
  assert(
    wav.format === 3 && wav.bitsPerSample === 32,
    `WAV is not 32-bit float: ${JSON.stringify(wav)}`,
  );
  assert(wav.rms > 0.0001 && wav.peak > 0.001, `WAV download is silent: ${JSON.stringify(wav)}`);
  const segmentRms = notes.map((note) =>
    rmsWindow(
      wav,
      Math.max(0, note.startPpq * 0.5 - 0.04),
      Math.min(wav.durationSeconds, (note.startPpq + note.durationPpq) * 0.5 + 0.04),
    ),
  );
  assert(
    segmentRms.every((value) => value > 0.00005),
    `WAV does not contain audible output for every corrected phrase note: ${JSON.stringify(segmentRms)}`,
  );
  return { bytes, wav, filename: download.suggestedFilename(), segmentRms, durationError };
}

export async function run({ page, baseUrl }) {
  const browserErrors = [];
  const { context, page: productionPage } = await freshPage(page);
  productionPage.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  productionPage.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  try {
    await startEmptyProject(productionPage, baseUrl);
    const audioClip = await importMelody(productionPage);
    const generated = await transcribeMelody(productionPage, audioClip);
    const initialNotes = generated.notes;
    const correctedNotes = await correctOneNote(productionPage, {
      clipId: generated.midiClip.id,
      notes: initialNotes,
    });
    const preset = await chooseSynthPreset(productionPage, generated.midiClip.id);
    await muteAudioTrack(productionPage, audioClip.id);
    const auditionResult = await audition(productionPage, generated.midiClip.id);
    assert(
      auditionResult.after > auditionResult.before + 0.02,
      `transport clock did not advance: ${JSON.stringify(auditionResult)}`,
    );

    await saveAs(productionPage);
    await reopenSavedProject(productionPage);

    const reopened = await productionPage.evaluate(() => window.__sonareDebug.clipRanges());
    const reopenedAudio = reopened.find((clip) => clip.kind === 'audio');
    const reopenedMidi = reopened.find((clip) => clip.kind === 'midi');
    assert(
      reopenedAudio && reopenedMidi,
      `saved project lost source/result clips: ${JSON.stringify(reopened)}`,
    );
    const projectEndPpq = Math.max(...reopened.map((clip) => clip.startPpq + clip.lengthPpq));
    const expectedDurationSeconds = projectEndPpq * 0.5;
    await selectClip(productionPage, reopenedMidi.id);
    const notesAfterReopen = sortNotes(
      await productionPage.evaluate(() => window.__sonareDebug.activeNotes()),
    );
    assert(
      notesAfterReopen.length === correctedNotes.length &&
        correctedNotes.every((expected) =>
          notesAfterReopen.some((actual) => noteMatches(actual, expected)),
        ),
      `corrected notes were not preserved after reopen: ${JSON.stringify({ correctedNotes, notesAfterReopen })}`,
    );
    const instrumentsAfterReopen = await productionPage.evaluate(() =>
      window.__sonareDebug.trackInstruments(),
    );
    assert(
      instrumentsAfterReopen.includes(preset),
      `saved project lost built-in synth preset ${preset}: ${JSON.stringify(instrumentsAfterReopen)}`,
    );
    await selectClip(productionPage, reopenedAudio.id);
    const audioMute = productionPage.locator('.track-header.active .toggle.mute');
    assert(
      (await audioMute.getAttribute('aria-pressed')) === 'true',
      'saved project lost the source audio track mute state',
    );
    await selectClip(productionPage, reopenedMidi.id);

    const smf = await exportSmf(productionPage);
    const correctedPitches = correctedNotes.map((note) => note.pitch).sort((a, b) => a - b);
    const smfPitches = smf.notes.map((note) => note.pitch).sort((a, b) => a - b);
    assert(
      JSON.stringify(smfPitches) === JSON.stringify(correctedPitches),
      `SMF note-ons do not match corrected clip: ${JSON.stringify({ smfPitches, correctedPitches })}`,
    );
    const expectedSmfNotes = sortNotes(correctedNotes).map((note) => ({
      pitch: note.pitch,
      startTick: Math.round(note.startPpq * smf.division),
      durationTicks: Math.round(note.durationPpq * smf.division),
    }));
    const tickMismatches = smf.notes.filter((actual, index) => {
      const expected = expectedSmfNotes[index];
      return (
        expected === undefined ||
        actual.pitch !== expected.pitch ||
        Math.abs(actual.startTick - expected.startTick) > 1 ||
        Math.abs(actual.durationTicks - expected.durationTicks) > 1
      );
    });
    assert(
      smf.notes.length === expectedSmfNotes.length && tickMismatches.length === 0,
      `SMF note timing does not match corrected clip within one tick: ${JSON.stringify({ division: smf.division, actual: smf.notes, expected: expectedSmfNotes })}`,
    );
    const wav = await exportWav(productionPage, expectedDurationSeconds, notesAfterReopen);
    console.info(
      `production audio-to-MIDI passed: mono ${initialNotes.length} notes ${JSON.stringify(initialNotes.map((note) => note.pitch))} -> ` +
        `corrected ${JSON.stringify(correctedPitches)}, ` +
        `preset ${preset}, SMF ${smf.filename} ${smf.bytes.length} bytes ` +
        `division=${smf.division} noteOns=${smf.notes.length} pitches=${JSON.stringify(smfPitches)}, ` +
        `WAV ${wav.filename} ${wav.bytes.length} bytes frames=${wav.wav.frames} ` +
        `duration=${wav.wav.durationSeconds.toFixed(3)}s expected=${expectedDurationSeconds.toFixed(3)}s ` +
        `segmentRms=${JSON.stringify(wav.segmentRms.map((value) => Number(value.toFixed(6))))} ` +
        `rms=${wav.wav.rms.toFixed(6)} peak=${wav.wav.peak.toFixed(6)} pcmHash=${wav.wav.pcmHash}`,
    );
    assert(
      browserErrors.length === 0,
      `browser errors during production flow: ${browserErrors.join(' | ')}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = browserErrors.length > 0 ? `; browser errors: ${browserErrors.join(' | ')}` : '';
    throw new Error(`${message}${detail}`, { cause: error });
  } finally {
    await context.close();
  }
}
