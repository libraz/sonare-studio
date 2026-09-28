/** Import GS setup SysEx, bind an SF2, and compare the actual rendered audio. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const name = 'gs-efx-sf2';

const sf2Path = fileURLToPath(new URL('../fixtures/minimal_gs.sf2', import.meta.url));
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
  for (let rest = value >>> 7; rest > 0; rest >>>= 7) bytes.unshift((rest & 0x7f) | 0x80);
  return bytes;
}

function chunk(id, bytes) {
  return [...ascii(id), ...u32(bytes.length), ...bytes];
}

function midiFile(withGs) {
  const events = [[0, 0xff, 0x03, 4, ...ascii('Lead')]];
  if (withGs) {
    const frames = [
      [0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x03, 0x00, 0x01, 0x10, 0x2c, 0xf7],
      [0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x03, 0x03, 0x7f, 0x3b, 0xf7],
      [0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x41, 0x22, 0x01, 0x5c, 0xf7],
    ];
    for (const frame of frames) events.push([0, 0xf0, ...vlq(frame.length - 1), ...frame.slice(1)]);
  }
  events.push([0, 0x90, 60, 110], [...vlq(1440), 0x80, 60, 0], [0, 0xff, 0x2f, 0]);
  return Buffer.from([
    ...chunk('MThd', [...u16(0), ...u16(1), ...u16(480)]),
    ...chunk('MTrk', events.flat()),
  ]);
}

async function importAndBind(page, baseUrl, withGs) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.locator('[data-testid="start-import-midi"]').waitFor({ state: 'visible' });
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('[data-testid="start-import-midi"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: withGs ? 'gs-efx.mid' : 'plain.mid',
    mimeType: 'audio/midi',
    buffer: midiFile(withGs),
  });
  await page.waitForFunction(
    () => window.__sonareDebug?.initialized() === true && window.__sonareDebug.trackCount() > 0,
    null,
    { timeout: 30000 },
  );
  const lead = await page.evaluate(() => {
    const clip = window.__sonareDebug
      .projectDocument()
      .tracks.find((track) => track.name === 'Lead')?.clips[0];
    if (!clip) throw new Error('import lost the Lead MIDI clip');
    return { notes: clip.notes.length };
  });
  if (lead.notes === 0) throw new Error('imported Lead MIDI clip has no notes');
  const arrange = await page.locator('.arrangement-canvas').boundingBox();
  await page.mouse.click(arrange.x + 20, arrange.y + 56);
  await page.waitForFunction(() => window.__sonareDebug.activeClipId() !== -1);
  if ((await page.evaluate(() => localStorage.getItem('sonare-studio.tourSeen'))) !== '1') {
    await page.locator('.tour-skip').click();
    await page.locator('.tour-overlay').waitFor({ state: 'detached' });
  }
  if (!(await page.locator('.device-rack').isVisible()))
    await page.click('.app-bar .devices-toggle');
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
      window.__sonareDebug.trackInstruments().includes('sf2') &&
      !window.__sonareDebug.applyPending(),
    null,
    { timeout: 30000 },
  );
  return page.evaluate(() => window.__sonareDebug.exportProbe(false, { startPpq: 0, endPpq: 3.8 }));
}

export async function run({ page, baseUrl, fail }) {
  // Keep this fixture in the scenario, rather than relying on a user font in OPFS.
  if (readFileSync(sf2Path).length < 100) fail('GS SoundFont fixture is incomplete');
  const plain = await importAndBind(page, baseUrl, false);
  const gs = await importAndBind(page, baseUrl, true);
  if (
    !Number.isFinite(plain.peakDb) ||
    !Number.isFinite(gs.peakDb) ||
    plain.peakDb < -40 ||
    gs.peakDb < -40 ||
    plain.hash === gs.hash
  ) {
    fail(`GS EFX had no audible effect on SF2 export: ${JSON.stringify({ plain, gs })}`);
  }
  console.info(`GS EFX changed SF2 WAV ${plain.hash} → ${gs.hash}`);
}
