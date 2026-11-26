/** Exercise the canonical mono/polyphonic audio-to-MIDI flow with real WASM. */
export const name = 'audio-transcribe';

const SAMPLE_RATE = 22050;
const PITCHES = [261.625565, 329.627557, 391.995436];

function chordWavBytes(seconds = 1) {
  const frames = Math.round(seconds * SAMPLE_RATE);
  const data = Buffer.alloc(frames * 2);
  for (let frame = 0; frame < frames; frame++) {
    const sample = PITCHES.reduce(
      (sum, frequency) => sum + 0.12 * Math.sin((2 * Math.PI * frequency * frame) / SAMPLE_RATE),
      0,
    );
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

async function importChord(page) {
  await page.click('.dock-tabs button:has-text("Media")');
  const before = await page.evaluate(() => window.__sonareDebug.clipRanges());
  await page.evaluate(() => window.__sonareDebug.seekPpq(0));
  await page.setInputFiles('.media-browser .file-input', {
    name: 'transcribe-c4-e4-g4.wav',
    mimeType: 'audio/wav',
    buffer: chordWavBytes(),
  });
  const asset = page
    .locator('.media-browser .asset-row', { hasText: 'transcribe-c4-e4-g4' })
    .last();
  await asset.waitFor({ state: 'visible', timeout: 20000 });
  await asset.locator('.add-button').click();
  await page.waitForFunction(
    (count) => window.__sonareDebug.clipCount() === count + 1,
    before.length,
    { timeout: 20000 },
  );
  const after = await page.evaluate(() => window.__sonareDebug.clipRanges());
  const clip = after.find((entry) => !before.some((existing) => existing.id === entry.id));
  if (clip?.kind !== 'audio')
    throw new Error(`audio fixture was not imported: ${JSON.stringify(clip)}`);
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), clip.id);
  return clip;
}

async function openTranscribe(page, clipId) {
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), clipId);
  const processButton = page.locator('.arrangement-process-group[aria-label="Audio clip"] button', {
    hasText: /^To MIDI$/,
  });
  await processButton.waitFor({ state: 'visible' });
  await processButton.click();
  const dialog = page.getByRole('dialog', { name: 'Transcribe audio to MIDI' });
  await dialog.waitFor({ state: 'visible' });
  return dialog;
}

async function waitForDelta(page, before, delta, label) {
  await page.waitForFunction(
    ({ count, delta: expected }) => window.__sonareDebug.noteCount() === count + expected,
    { count: before, delta },
    { timeout: 30000 },
  );
  const after = await page.evaluate(() => window.__sonareDebug.noteCount());
  if (after !== before + delta) {
    throw new Error(`${label} note count changed unexpectedly: ${before} -> ${after}`);
  }
}

export async function run({ page, fail }) {
  const source = await importChord(page);
  const initial = await page.evaluate(() => ({
    clips: window.__sonareDebug.clipCount(),
    tracks: window.__sonareDebug.trackCount(),
    notes: window.__sonareDebug.noteCount(),
  }));

  // Closing before dispatch is the deterministic browser-level cancellation
  // check. The component tests cover cancelling an active worker request.
  const cancelDialog = await openTranscribe(page, source.id);
  await cancelDialog.locator('.modal-foot button').first().click();
  await cancelDialog.waitFor({ state: 'hidden' });
  const afterCancel = await page.evaluate(() => ({
    clips: window.__sonareDebug.clipCount(),
    tracks: window.__sonareDebug.trackCount(),
    notes: window.__sonareDebug.noteCount(),
  }));
  if (JSON.stringify(afterCancel) !== JSON.stringify(initial)) {
    fail(`cancel changed the project: ${JSON.stringify({ initial, afterCancel })}`);
  }

  // Cancel an active request in the same browser turn. This exercises the
  // busy dialog and abort path without depending on detector execution time.
  const activeCancelDialog = await openTranscribe(page, source.id);
  await activeCancelDialog.evaluate(async (dialog) => {
    dialog.querySelector('.modal-foot button.primary').click();
    await Promise.resolve();
    const cancel = dialog.querySelector('.modal-foot button');
    if (cancel.textContent.trim() !== 'Cancel')
      throw new Error('active request is not cancellable');
    cancel.click();
  });
  await activeCancelDialog.waitFor({ state: 'hidden' });
  const afterActiveCancel = await page.evaluate(() => ({
    clips: window.__sonareDebug.clipCount(),
    tracks: window.__sonareDebug.trackCount(),
    notes: window.__sonareDebug.noteCount(),
  }));
  if (JSON.stringify(afterActiveCancel) !== JSON.stringify(initial)) {
    fail(`active cancel changed the project: ${JSON.stringify({ initial, afterActiveCancel })}`);
  }

  const melodyDialog = await openTranscribe(page, source.id);
  const melodyBefore = await page.evaluate(() => ({
    clips: window.__sonareDebug.clipCount(),
    tracks: window.__sonareDebug.trackCount(),
    notes: window.__sonareDebug.noteCount(),
  }));
  await melodyDialog.locator('.modal-foot button.primary').click();
  await page.getByRole('button', { name: 'Transcribing…' }).waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => !document.querySelector('.modal-card[aria-label="Transcribe audio to MIDI"]'),
    null,
    { timeout: 30000 },
  );
  await waitForDelta(page, melodyBefore.notes, 1, 'melody');
  const melodyAfter = await page.evaluate(() => ({
    clips: window.__sonareDebug.clipCount(),
    tracks: window.__sonareDebug.trackCount(),
  }));
  if (
    melodyAfter.clips !== melodyBefore.clips + 1 ||
    melodyAfter.tracks !== melodyBefore.tracks + 1
  ) {
    throw new Error(
      `melody transcription did not add one track and clip: ${JSON.stringify({ melodyBefore, melodyAfter })}`,
    );
  }

  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForFunction(
    ({ clips, tracks, notes }) =>
      window.__sonareDebug.clipCount() === clips &&
      window.__sonareDebug.trackCount() === tracks &&
      window.__sonareDebug.noteCount() === notes,
    melodyBefore,
    { timeout: 10000 },
  );

  const polyDialog = await openTranscribe(page, source.id);
  await polyDialog.getByRole('radio', { name: /Polyphonic/ }).click();
  if (
    (await polyDialog.getByRole('radio', { name: /Polyphonic/ }).getAttribute('aria-checked')) !==
    'true'
  ) {
    throw new Error('polyphonic mode did not become selected');
  }
  const polyBefore = await page.evaluate(() => ({
    clips: window.__sonareDebug.clipCount(),
    tracks: window.__sonareDebug.trackCount(),
    notes: window.__sonareDebug.noteCount(),
  }));
  await polyDialog.locator('.modal-foot button.primary').click();
  await page.waitForFunction(
    () => !document.querySelector('.modal-card[aria-label="Transcribe audio to MIDI"]'),
    null,
    { timeout: 30000 },
  );
  await waitForDelta(page, polyBefore.notes, 3, 'polyphonic');
  const polyAfter = await page.evaluate(() => ({
    clips: window.__sonareDebug.clipCount(),
    tracks: window.__sonareDebug.trackCount(),
    notes: window.__sonareDebug.activeNotes(),
    activeClipId: window.__sonareDebug.activeClipId(),
    ranges: window.__sonareDebug.clipRanges(),
  }));
  if (polyAfter.clips !== polyBefore.clips + 1 || polyAfter.tracks !== polyBefore.tracks + 1) {
    throw new Error(
      `polyphonic transcription did not add one track and clip: ${JSON.stringify({ polyBefore, polyAfter })}`,
    );
  }
  const newNotes = polyAfter.notes.slice(-3);
  const pitches = newNotes.map((note) => note.pitch).sort((a, b) => a - b);
  const overlapStart = Math.max(...newNotes.map((note) => note.startPpq));
  const overlapEnd = Math.min(...newNotes.map((note) => note.startPpq + note.durationPpq));
  if (
    newNotes.length !== 3 ||
    JSON.stringify(pitches) !== JSON.stringify([60, 64, 67]) ||
    !(overlapEnd > overlapStart) ||
    polyAfter.ranges.find((clip) => clip.id === polyAfter.activeClipId)?.kind !== 'midi'
  ) {
    throw new Error(
      `polyphonic notes were not the selected overlapping C-major chord: ${JSON.stringify({
        newNotes,
        pitches,
        overlapStart,
        overlapEnd,
        activeClipId: polyAfter.activeClipId,
      })}`,
    );
  }

  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForFunction(
    ({ clips, tracks, notes }) =>
      window.__sonareDebug.clipCount() === clips &&
      window.__sonareDebug.trackCount() === tracks &&
      window.__sonareDebug.noteCount() === notes,
    polyBefore,
    { timeout: 10000 },
  );
  console.info(
    'real-WASM audio transcription produced one melody note and three overlapping polyphonic notes; Undo and dialog cancel restored the project',
  );
}
