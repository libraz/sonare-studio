import { makeWavBytes } from '../harness.mjs';

/** Edit imported MIDI and audio clips through the arrangement timeline. */
export const name = 'audio-arrangement-edit';

const ASCII = (value) => [...value].map((char) => char.charCodeAt(0));

function u16(value) {
  return [(value >>> 8) & 255, value & 255];
}

function u32(value) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function vlq(value) {
  const bytes = [value & 0x7f];
  for (let remaining = value >>> 7; remaining > 0; remaining >>>= 7) {
    bytes.unshift((remaining & 0x7f) | 0x80);
  }
  return bytes;
}

function chunk(id, bytes) {
  return [...ASCII(id), ...u32(bytes.length), ...bytes];
}

function meta(type, data) {
  return [0xff, type, ...vlq(data.length), ...data];
}

function midiTrack(name, events) {
  const ordered = [
    { tick: 0, bytes: meta(0x03, ASCII(name)) },
    ...events,
    { tick: 16 * 480, bytes: meta(0x2f, []) },
  ].sort((a, b) => a.tick - b.tick);
  let previous = 0;
  const bytes = [];
  for (const event of ordered) {
    bytes.push(...vlq(event.tick - previous), ...event.bytes);
    previous = event.tick;
  }
  return chunk('MTrk', bytes);
}

function notes(channel, pitches, startBeat, durationBeats, velocity = 92) {
  return pitches.flatMap((pitch) => [
    { tick: startBeat * 480, bytes: [0x90 | channel, pitch, velocity] },
    { tick: (startBeat + durationBeats) * 480, bytes: [0x80 | channel, pitch, 0] },
  ]);
}

/** A small four-part song used to make the arrangement fixture self-contained. */
function importedSongBytes() {
  const tempo = midiTrack('Conductor', [
    { tick: 0, bytes: meta(0x51, [0x09, 0x27, 0xc0]) }, // 100 BPM
    { tick: 0, bytes: meta(0x58, [4, 2, 24, 8]) },
    { tick: 0, bytes: meta(0x59, [0, 0]) },
  ]);
  const lead = midiTrack(
    'Lead',
    [60, 62, 64, 67, 69, 67, 64, 62].flatMap((pitch, beat) => notes(0, [pitch], beat, 0.9)),
  );
  const bass = midiTrack(
    'Bass',
    [0, 5, 7, 0].flatMap((root, bar) => notes(1, [36 + root], bar * 4, 3.8)),
  );
  const backing = midiTrack('Backing', [
    ...notes(2, [60, 64, 67], 0, 3.8),
    ...notes(2, [65, 69, 72], 4, 3.8),
    ...notes(2, [67, 71, 74], 8, 3.8),
    ...notes(2, [60, 64, 67], 12, 3.8),
  ]);
  const drums = midiTrack(
    'Drums',
    Array.from({ length: 16 }, (_, beat) => [
      ...notes(9, [beat % 4 === 1 || beat % 4 === 3 ? 38 : 36], beat, 0.2),
      ...notes(9, [42], beat, 0.2),
    ]).flat(),
  );
  return Uint8Array.from(
    [
      ...chunk('MThd', [...u16(1), ...u16(5), ...u16(480)]),
      tempo,
      lead,
      bass,
      backing,
      drums,
    ].flat(),
  );
}

async function arrangementGeometry(page, trackId, ppq) {
  return page.evaluate(
    ({ trackId, ppq }) => {
      const canvas = document.querySelector('.arrangement-canvas');
      const component = canvas?.__vueParentComponent;
      const props = component?.props;
      const range = props?.range;
      const tracks = props?.tracks;
      const rowLayout = props?.rowLayout;
      if (!canvas || !props || !range || !tracks || !rowLayout) return null;
      const index = tracks.findIndex((track) => track.id === trackId);
      if (index < 0) return null;
      const rect = canvas.getBoundingClientRect();
      const rulerHeight = 28;
      const localY = rulerHeight + rowLayout.rowTop(index) - props.scrollY + props.laneHeight / 2;
      return {
        x: rect.left + range.ppqToX(ppq),
        y: rect.top + localY,
        localY,
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
      };
    },
    { trackId, ppq },
  );
}

/** Resolve a timeline point after scrolling the owning lane into view. */
async function arrangementPoint(page, trackId, ppq) {
  let lastPoint;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const point = await arrangementGeometry(page, trackId, ppq);
    if (!point) throw new Error(`arrangement lane missing for track ${trackId}`);
    lastPoint = point;
    if (point.y >= point.top + 32 && point.y <= point.bottom - 2) {
      return { x: point.x, y: point.y };
    }
    const direction = point.y > point.bottom ? 1 : -1;
    await page.mouse.move(point.left + Math.min(160, point.width / 2), point.top + 120);
    await page.mouse.wheel(0, direction * 280);
    await page.waitForTimeout(50);
  }
  throw new Error(
    `arrangement lane could not be revealed for track ${trackId}: ${JSON.stringify(lastPoint)}`,
  );
}

async function importAudio(page, name, seconds, frequencyHz) {
  const before = await page.evaluate(() => window.__sonareDebug.clipRanges());
  await page.evaluate(() => window.__sonareDebug.seekPpq(0));
  await page.setInputFiles('.media-browser .file-input', {
    name: `${name}.wav`,
    mimeType: 'audio/wav',
    buffer: Buffer.from(makeWavBytes(seconds, frequencyHz)),
  });
  const asset = page.locator('.media-browser .asset-row', { hasText: name }).last();
  await asset.waitFor({ state: 'visible', timeout: 20000 });
  await asset.locator('.add-button').click();
  await page.waitForFunction(
    (count) => window.__sonareDebug.clipCount() === count + 1,
    before.length,
    { timeout: 20000 },
  );
  const after = await page.evaluate(() => window.__sonareDebug.clipRanges());
  const clip = after.find((entry) => !before.some((existing) => existing.id === entry.id));
  if (clip?.kind !== 'audio' || clip?.startPpq !== 0) {
    throw new Error(`audio fixture was not added at bar one: ${JSON.stringify(clip)}`);
  }
  return clip;
}

async function waitForClip(page, id, predicate, timeout = 10000) {
  await page.waitForFunction(
    ({ id, expected }) => {
      const clip = window.__sonareDebug.clipRanges().find((entry) => entry.id === id);
      if (!clip) return false;
      return Object.entries(expected).every(([key, value]) => {
        const actual = clip[key];
        return typeof actual === 'number' && Math.abs(actual - value) <= 1e-6;
      });
    },
    { id, expected: predicate },
    { timeout },
  );
}

function near(actual, expected, epsilon = 1e-6) {
  return Math.abs(actual - expected) <= epsilon;
}

export async function run({ page, baseUrl, fail }) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.locator('[data-testid="start-import-midi"]').waitFor({ state: 'visible' });
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('[data-testid="start-import-midi"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'arrangement-edit-song.mid',
    mimeType: 'audio/midi',
    buffer: Buffer.from(importedSongBytes()),
  });
  await page.waitForFunction(
    () => window.__sonareDebug?.initialized() === true && window.__sonareDebug.trackCount() >= 4,
    null,
    { timeout: 30000 },
  );

  if ((await page.evaluate(() => localStorage.getItem('sonare-studio.tourSeen'))) !== '1') {
    await page.locator('.tour-tooltip').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('.tour-skip').click();
    await page.locator('.tour-overlay').waitFor({ state: 'detached' });
  }

  const imported = await page.evaluate(() => ({
    tracks: window.__sonareDebug.trackCount(),
    notes: window.__sonareDebug.noteCount(),
    instruments: window.__sonareDebug.trackInstruments(),
  }));
  if (imported.tracks !== 4 || imported.notes !== 8 || !imported.instruments.includes('drum-kit')) {
    fail(
      `multitrack MIDI fixture was not loaded before audio editing: ${JSON.stringify(imported)}`,
    );
    return;
  }

  await page.click('.dock-tabs button:has-text("Lists")');
  await page.locator('.list-tab[data-tab-id="chords"]').click();
  await page.locator('.list-actions button').filter({ hasText: 'Estimate progression' }).click();
  await page.waitForFunction(() => window.__sonareDebug.chordRanges().length === 4);

  await page.click('.dock-tabs button:has-text("Media")');
  const reference = await importAudio(page, 'arrangement-reference', 3.6, 330);
  const take = await importAudio(page, 'arrangement-take', 2.4, 550);
  const initialAudio = await page.evaluate(() =>
    window.__sonareDebug.clipRanges().filter((clip) => clip.kind === 'audio'),
  );
  if (initialAudio.length !== 2 || initialAudio.some((clip) => clip.startPpq !== 0)) {
    fail(`expected two short audio clips at the first bar: ${JSON.stringify(initialAudio)}`);
    return;
  }
  if (!(reference.lengthPpq > take.lengthPpq && take.lengthPpq > 1)) {
    fail(
      `audio fixture durations are not suitable for snap editing: ${JSON.stringify({ reference, take })}`,
    );
    return;
  }

  // Select the take through the actual arrangement canvas and confirm that
  // the audio inspector follows the selected clip.
  const takeCenter = await arrangementPoint(page, take.trackId, take.startPpq + take.lengthPpq / 2);
  await page.mouse.click(takeCenter.x, takeCenter.y);
  await page.waitForFunction((id) => window.__sonareDebug.activeClipId() === id, take.id);
  await page.locator('.clip-inspector').waitFor({ state: 'visible' });
  const inspectorInputs = page.locator('.clip-inspector .ci-field input');
  if ((await inspectorInputs.count()) !== 3) {
    fail('selected audio clip did not expose gain, fade-in and fade-out controls');
    return;
  }

  // Drag the body by an intentionally fractional amount whose destination is
  // on a whole-beat snap line. The resulting range is the source of truth.
  const moveStart = 4;
  const moveFrom = await arrangementPoint(page, take.trackId, take.startPpq + take.lengthPpq / 2);
  const moveTo = await arrangementPoint(page, take.trackId, moveStart + take.lengthPpq / 2);
  await page.mouse.move(moveFrom.x, moveFrom.y);
  await page.mouse.down();
  await page.mouse.move(moveTo.x, moveTo.y, { steps: 6 });
  await page.mouse.up();
  await waitForClip(page, take.id, { startPpq: moveStart });
  let moved = (await page.evaluate(() => window.__sonareDebug.clipRanges())).find(
    (clip) => clip.id === take.id,
  );
  if (!moved || !near(moved.startPpq, moveStart)) {
    fail(`audio body move did not snap to PPQ ${moveStart}: ${JSON.stringify(moved)}`);
    return;
  }

  await page.keyboard.press('Meta+z');
  await waitForClip(page, take.id, { startPpq: 0 });
  await page.keyboard.press('Meta+Shift+z');
  await waitForClip(page, take.id, { startPpq: moveStart });
  console.info('audio clip moved on the arrangement grid and restored through Undo/Redo');

  // Trim the right edge one snapped beat earlier. The source clip is longer
  // than its edited window, leaving enough material for the optional crossfade.
  moved = (await page.evaluate(() => window.__sonareDebug.clipRanges())).find(
    (clip) => clip.id === take.id,
  );
  if (!moved) throw new Error('moved audio clip disappeared before trim');
  const originalEnd = moved.startPpq + moved.lengthPpq;
  const trimEnd = moved.startPpq + Math.max(1, Math.floor(moved.lengthPpq) - 1);
  if (!(trimEnd > moved.startPpq && trimEnd < originalEnd)) {
    fail(`audio clip is too short to exercise a snapped trim: ${JSON.stringify(moved)}`);
    return;
  }
  const trimFrom = await arrangementPoint(page, moved.trackId, originalEnd - 0.02);
  const trimTo = await arrangementPoint(page, moved.trackId, trimEnd);
  await page.mouse.move(trimFrom.x, trimFrom.y);
  await page.mouse.down();
  await page.mouse.move(trimTo.x, trimTo.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(
    ({ id, end }) => {
      const clip = window.__sonareDebug.clipRanges().find((entry) => entry.id === id);
      return clip !== undefined && clip.startPpq + clip.lengthPpq < end - 0.5;
    },
    { id: moved.id, end: originalEnd },
  );
  const trimmed = (await page.evaluate(() => window.__sonareDebug.clipRanges())).find(
    (clip) => clip.id === moved.id,
  );
  if (
    !trimmed ||
    !near(trimmed.startPpq, moved.startPpq) ||
    !(trimmed.lengthPpq < moved.lengthPpq)
  ) {
    fail(
      `audio edge trim did not preserve the start and shorten the window: ${JSON.stringify(trimmed)}`,
    );
    return;
  }
  const trimLength = trimmed.lengthPpq;
  await page.keyboard.press('Meta+z');
  await waitForClip(page, moved.id, { lengthPpq: moved.lengthPpq });
  await page.keyboard.press('Meta+Shift+z');
  await waitForClip(page, moved.id, { lengthPpq: trimLength });
  console.info('audio clip edge trim followed the snap grid and restored through Undo/Redo');

  // Split through the clip's own context menu. This keeps the hit point tied
  // to the current TimelineRange even when the arrangement has scrolled.
  const splitClip = (await page.evaluate(() => window.__sonareDebug.clipRanges())).find(
    (clip) => clip.id === moved.id,
  );
  if (!splitClip) throw new Error('trimmed audio clip missing before split');
  const splitOffset = Math.max(
    1,
    Math.min(splitClip.lengthPpq - 1, Math.round(splitClip.lengthPpq / 2)),
  );
  const splitPpq = splitClip.startPpq + splitOffset;
  const splitPoint = await arrangementPoint(page, splitClip.trackId, splitPpq);
  const countBeforeSplit = await page.evaluate(() => window.__sonareDebug.clipCount());
  await page.mouse.click(splitPoint.x, splitPoint.y, { button: 'right' });
  const splitMenu = page.locator('.context-menu-item[data-menu-item-id="split"]');
  await splitMenu.waitFor({ state: 'visible' });
  if (await splitMenu.isDisabled()) {
    fail(`audio split was disabled at an interior snapped position PPQ ${splitPpq}`);
    return;
  }
  await splitMenu.click();
  await page.waitForFunction(
    (count) => window.__sonareDebug.clipCount() === count + 1,
    countBeforeSplit,
  );
  let pieces = await page.evaluate(
    (trackId) =>
      window.__sonareDebug
        .clipRanges()
        .filter((clip) => clip.trackId === trackId && clip.kind === 'audio'),
    splitClip.trackId,
  );
  pieces.sort((a, b) => a.startPpq - b.startPpq);
  if (
    pieces.length < 2 ||
    !near(pieces[0].startPpq, splitClip.startPpq) ||
    !near(pieces[1].startPpq, pieces[0].startPpq + pieces[0].lengthPpq)
  ) {
    fail(`audio split produced non-contiguous windows: ${JSON.stringify({ splitClip, pieces })}`);
    return;
  }
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(
    ({ count, trackId }) =>
      window.__sonareDebug.clipCount() === count &&
      window.__sonareDebug
        .clipRanges()
        .filter((clip) => clip.trackId === trackId && clip.kind === 'audio').length === 1,
    { count: countBeforeSplit, trackId: splitClip.trackId },
  );
  await page.keyboard.press('Meta+Shift+z');
  await page.waitForFunction(
    ({ count, trackId }) =>
      window.__sonareDebug.clipCount() === count + 1 &&
      window.__sonareDebug
        .clipRanges()
        .filter((clip) => clip.trackId === trackId && clip.kind === 'audio').length === 2,
    { count: countBeforeSplit, trackId: splitClip.trackId },
  );
  pieces = await page.evaluate(
    (trackId) =>
      window.__sonareDebug
        .clipRanges()
        .filter((clip) => clip.trackId === trackId && clip.kind === 'audio'),
    splitClip.trackId,
  );
  pieces.sort((a, b) => a.startPpq - b.startPpq);
  const editedLeft = pieces[0];

  // Apply three inspector edits as three undoable commands, then walk them
  // backward and forward to ensure the audio settings survive arrangement edits.
  const leftPoint = await arrangementPoint(
    page,
    editedLeft.trackId,
    editedLeft.startPpq + editedLeft.lengthPpq / 2,
  );
  await page.mouse.click(leftPoint.x, leftPoint.y);
  await page.waitForFunction((id) => window.__sonareDebug.activeClipId() === id, editedLeft.id);
  const baseline = await page.evaluate(
    (id) => window.__sonareDebug.clipSettings(id),
    editedLeft.id,
  );
  const fade = Math.min(0.5, editedLeft.lengthPpq / 4);
  await inspectorInputs.nth(0).fill('-6');
  await inspectorInputs.nth(0).press('Tab');
  await inspectorInputs.nth(1).fill(String(fade));
  await inspectorInputs.nth(1).press('Tab');
  await inspectorInputs.nth(2).fill(String(fade));
  await inspectorInputs.nth(2).press('Tab');
  await page.waitForFunction(
    ({ id, fade }) => {
      const settings = window.__sonareDebug.clipSettings(id);
      return (
        settings !== null &&
        Math.abs(settings.gain - 0.501) < 0.02 &&
        Math.abs((settings.fadeInPpq ?? 0) - fade) < 1e-6 &&
        Math.abs((settings.fadeOutPpq ?? 0) - fade) < 1e-6
      );
    },
    { id: editedLeft.id, fade },
  );
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(
    ({ id, baseline }) => {
      const settings = window.__sonareDebug.clipSettings(id);
      return (
        settings !== null &&
        Math.abs(settings.gain - baseline.gain) < 1e-6 &&
        (settings.fadeInPpq ?? 0) === (baseline.fadeInPpq ?? 0) &&
        (settings.fadeOutPpq ?? 0) === (baseline.fadeOutPpq ?? 0)
      );
    },
    { id: editedLeft.id, baseline },
  );
  await page.keyboard.press('Meta+Shift+z');
  await page.keyboard.press('Meta+Shift+z');
  await page.keyboard.press('Meta+Shift+z');
  await page.waitForFunction(
    ({ id, fade }) => {
      const settings = window.__sonareDebug.clipSettings(id);
      return settings !== null && Math.abs((settings.fadeOutPpq ?? 0) - fade) < 1e-6;
    },
    { id: editedLeft.id, fade },
  );
  console.info('split audio clip gain and fades survived inspector Undo/Redo');

  // This split pair has unused source material and must support a real
  // crossfade. Treat a disabled action as a regression in the edit flow.
  const crossfadePoint = await arrangementPoint(
    page,
    editedLeft.trackId,
    editedLeft.startPpq + editedLeft.lengthPpq / 2,
  );
  await page.mouse.click(crossfadePoint.x, crossfadePoint.y, { button: 'right' });
  const crossfade = page.locator('.context-menu-item[data-menu-item-id="crossfade"]');
  await crossfade.waitFor({ state: 'visible' });
  if (await crossfade.isDisabled()) {
    await page.keyboard.press('Escape');
    fail('crossfade was disabled for touching audio clips with unused source material');
    return;
  } else {
    await crossfade.click();
    await page.waitForFunction(
      ({ leftId, rightId }) => {
        const leftSettings = window.__sonareDebug.clipSettings(leftId);
        const rightSettings = window.__sonareDebug.clipSettings(rightId);
        return (
          leftSettings !== null &&
          rightSettings !== null &&
          (leftSettings.fadeOutPpq ?? 0) > 0 &&
          (rightSettings.fadeInPpq ?? 0) > 0
        );
      },
      { leftId: editedLeft.id, rightId: pieces[1].id },
      { timeout: 10000 },
    );
    console.info('eligible adjacent audio clips crossfaded through the context menu');
  }

  const finalState = await page.evaluate(() => ({
    tracks: window.__sonareDebug.trackCount(),
    clips: window.__sonareDebug.clipRanges(),
    audio: window.__sonareDebug.clipRanges().filter((clip) => clip.kind === 'audio'),
  }));
  if (finalState.tracks < 6 || finalState.audio.length < 3) {
    fail(`audio arrangement edits left an incomplete song: ${JSON.stringify(finalState)}`);
  } else {
    console.info(
      `arrangement edit chain left ${finalState.tracks} tracks and ${finalState.audio.length} valid audio windows for DAWproject export`,
    );
  }
}
