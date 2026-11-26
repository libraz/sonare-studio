/** Import and edit a small multitrack MIDI song through the start screen. */
import { nextPaint } from '../harness.mjs';
export const name = 'imported-song-edit';

const ascii = (value) => [...value].map((char) => char.charCodeAt(0));
const u16 = (value) => [(value >>> 8) & 255, value & 255];
const u32 = (value) => [
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];

function vlq(value) {
  const bytes = [value & 0x7f];
  for (let remaining = value >>> 7; remaining > 0; remaining >>>= 7) {
    bytes.unshift((remaining & 0x7f) | 0x80);
  }
  return bytes;
}

function chunk(id, bytes) {
  return [...ascii(id), ...u32(bytes.length), ...bytes];
}

function meta(type, data) {
  return [0xff, type, ...vlq(data.length), ...data];
}

function midiTrack(name, events) {
  const ordered = [
    { tick: 0, bytes: meta(0x03, ascii(name)) },
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

function songBytes() {
  const tempo = midiTrack('Conductor', [
    { tick: 0, bytes: meta(0x51, [0x09, 0x27, 0xc0]) }, // 100 BPM
    { tick: 0, bytes: meta(0x58, [4, 2, 24, 8]) },
    { tick: 0, bytes: meta(0x59, [0, 0]) }, // C major
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

export async function pointForNote(page, pitch, ppq) {
  return page.evaluate(
    ({ pitch, ppq }) => {
      const grid = document.querySelector('.note-grid');
      const range = grid?.__vueParentComponent?.props.range;
      if (!grid || !range) throw new Error('piano roll grid is not visible');
      const rect = grid.getBoundingClientRect();
      const x = range.ppqToX(ppq);
      const y = range.pitchToY(pitch) + range.rowHeight / 2;
      if (x < 10 || x > rect.width - 10 || y < 8 || y > rect.height - 8) {
        throw new Error(`MIDI note ${pitch} at PPQ ${ppq} is outside the piano roll`);
      }
      return { x: rect.left + x, y: rect.top + y };
    },
    { pitch, ppq },
  );
}

async function canvasRows(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.note-grid canvas');
    const context = canvas?.getContext('2d');
    if (!canvas || !context) throw new Error('piano roll background canvas missing');
    const dpr = canvas.width / canvas.clientWidth;
    const x = Math.round(canvas.clientWidth * 0.2 * dpr);
    return Array.from({ length: Math.floor(canvas.clientHeight) - 10 }, (_, row) => {
      const pixel = context.getImageData(x, Math.round((row + 5) * dpr), 1, 1).data;
      return [pixel[0], pixel[1], pixel[2]];
    });
  });
}

/** Sets the Row tint toggle, which lives in the View popover, then closes the popover. */
async function setRowTint(page, on) {
  const view = page.locator('.roll-toolbar .tb-menu').filter({ hasText: /^\s*View\s*$/ });
  await view.click();
  const toggle = page.locator('.view-popover button[aria-label="Row tint"]');
  // Drum tracks have no harmony, so the toggle is disabled there and left as is.
  if (
    (await toggle.isEnabled()) &&
    ((await toggle.getAttribute('aria-pressed')) === 'true') !== on
  ) {
    await toggle.click();
  }
  await view.click();
  await page.locator('.view-popover').waitFor({ state: 'hidden' });
  await nextPaint(page);
}

async function guidanceDeltas(page) {
  await setRowTint(page, false);
  const off = await canvasRows(page);
  await setRowTint(page, true);
  const on = await canvasRows(page);
  return on.map((row, index) => row.map((value, channel) => value - off[index][channel]));
}

export async function run({ page, baseUrl, fail }) {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.locator('[data-testid="start-import-midi"]').waitFor({ state: 'visible' });
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('[data-testid="start-import-midi"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'existing-song.mid',
    mimeType: 'audio/midi',
    buffer: Buffer.from(songBytes()),
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
  const summary = await page.evaluate(() => ({
    tracks: window.__sonareDebug.trackCount(),
    activeNotes: window.__sonareDebug.noteCount(),
    instruments: window.__sonareDebug.trackInstruments(),
  }));
  if (
    summary.tracks !== 4 ||
    summary.activeNotes !== 8 ||
    !summary.instruments.includes('drumKit')
  ) {
    fail(`imported song lost its parts: ${JSON.stringify(summary)}`);
  }
  console.info(`imported song: ${summary.tracks} tracks, ${summary.activeNotes} active notes`);

  await page.click('.dock-tabs button:has-text("Lists")');
  await page.locator('.list-tab[data-tab-id="chords"]').click();
  await page.locator('.list-actions button').filter({ hasText: 'Estimate progression' }).click();
  await page.locator('.chord-row').first().waitFor({ state: 'visible' });
  const estimated = await page.locator('.chord-row .cell-name').allTextContents();
  if (estimated.join(',') !== 'C,F,G,C') {
    fail(`drums or other parts distorted the imported progression: ${estimated.join(',')}`);
  }
  console.info(`estimated chords from imported parts: ${estimated.join('–')}`);

  await page.click('.dock-tabs button:has-text("Piano Roll")');
  await page.locator('.roll-toolbar .tb-segmented[role="group"] .tb-seg').first().click();
  await page.locator('.roll-toolbar .tb-segmented[role="group"] .tb-seg').nth(1).click();
  const leadDeltas = await guidanceDeltas(page);
  const changed = leadDeltas.filter(
    ([red, green, blue]) => Math.abs(red) + Math.abs(green) + Math.abs(blue) >= 5,
  );
  const safeRows = changed.filter(([red, green, blue]) => green > red + 4 && green > blue + 3);
  const warningRows = changed.filter(([red, green, blue]) => red > green + 4 && green > blue + 4);
  const clashRows = changed.filter(
    ([red, green, blue]) => red > green + 14 && Math.abs(green - blue) < 8,
  );
  if (!safeRows.length || !warningRows.length || !clashRows.length) {
    fail(
      `imported lead lacks distinct safe/caution/clash row tints: ${JSON.stringify({ safe: safeRows.length, warning: warningRows.length, clash: clashRows.length })}`,
    );
  }

  await page.locator('.tool-palette .tool-button').nth(1).click();
  const leadBefore = await page.evaluate(() => window.__sonareDebug.activeNotes());
  const leadPoint = await pointForNote(page, 64, 7.5);
  await page.mouse.click(leadPoint.x, leadPoint.y);
  await page.waitForFunction(
    (count) => window.__sonareDebug.activeNotes().length === count + 1,
    leadBefore.length,
  );
  const leadAfter = await page.evaluate(() => window.__sonareDebug.activeNotes());
  const addedLead = leadAfter.find((note) => !leadBefore.some((before) => before.id === note.id));
  if (addedLead?.pitch !== 64 || addedLead.channel !== 0) {
    fail(`new imported melody note changed pitch/channel: ${JSON.stringify(addedLead)}`);
  }
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForFunction(
    (count) => window.__sonareDebug.activeNotes().length === count,
    leadBefore.length,
  );

  const scale = page.locator('.roll-toolbar button[aria-label="Scale"]');
  if ((await scale.getAttribute('aria-pressed')) !== 'true') await scale.click();
  await page
    .locator('.legend-chip')
    .filter({ hasText: /^Drums$/ })
    .click();
  await page.locator('.roll-toolbar .tb-segmented[role="group"] .tb-seg').first().click();
  await page.locator('.roll-toolbar .tb-segmented[role="group"] .tb-seg').nth(1).click();
  const drumDeltas = await guidanceDeltas(page);
  if (
    drumDeltas.some(([red, green, blue]) => Math.abs(red) + Math.abs(green) + Math.abs(blue) >= 5)
  ) {
    fail('harmonic pitch-row guidance painted the drum editor');
  }
  if (!(await scale.isDisabled())) fail('Scale snap can still be enabled on a drum track');
  const drumBefore = await page.evaluate(() => window.__sonareDebug.activeNotes());
  const drumPoint = await pointForNote(page, 37, 10.5);
  await page.mouse.click(drumPoint.x, drumPoint.y);
  await page.waitForFunction(
    (count) => window.__sonareDebug.activeNotes().length === count + 1,
    drumBefore.length,
  );
  const drumAfter = await page.evaluate(() => window.__sonareDebug.activeNotes());
  const addedDrum = drumAfter.find((note) => !drumBefore.some((before) => before.id === note.id));
  if (addedDrum?.pitch !== 37 || addedDrum.channel !== 9) {
    fail(`drum hit changed GM instrument or channel: ${JSON.stringify(addedDrum)}`);
  }
  await page.mouse.move(0, 0);
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForFunction(
    (count) => window.__sonareDebug.activeNotes().length === count,
    drumBefore.length,
  );
  console.info('edited and undid melody/drum notes without changing their MIDI channels');
  if (browserErrors.length) fail(`browser errors: ${browserErrors.join(' | ')}`);
}
