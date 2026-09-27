/** Align an imported alternate take to a reference through the clip menu. */
export const name = 'audio-alignment';

const PITCHES = [60, 64, 67, 72, 71, 67, 64, 62];

function melodyWav(stepSeconds) {
  const sampleRate = 22050;
  const stepFrames = Math.round(stepSeconds * sampleRate);
  const data = Buffer.alloc(stepFrames * PITCHES.length * 2);
  for (const [index, pitch] of PITCHES.entries()) {
    const hz = 440 * 2 ** ((pitch - 69) / 12);
    for (let frame = 0; frame < stepFrames; frame++) {
      const sample = Math.sin((2 * Math.PI * hz * frame) / sampleRate) * 0.3;
      data.writeInt16LE(Math.round(sample * 32767), (index * stepFrames + frame) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function importAtStart(page, name, secondsPerNote) {
  const before = await page.evaluate(() => window.__sonareDebug.clipRanges());
  await page.evaluate(() => window.__sonareDebug.seekPpq(0));
  await page.setInputFiles('.media-browser .file-input', {
    name: `${name}.wav`,
    mimeType: 'audio/wav',
    buffer: melodyWav(secondsPerNote),
  });
  const asset = page.locator('.media-browser .asset-row', { hasText: name }).first();
  await asset.waitFor({ state: 'visible', timeout: 20000 });
  await asset.locator('.add-button').click();
  await page.waitForFunction(
    (count) => window.__sonareDebug.clipCount() === count + 1,
    before.length,
  );
  const after = await page.evaluate(() => window.__sonareDebug.clipRanges());
  const added = after.find((clip) => !before.some((existing) => existing.id === clip.id));
  if (added?.kind !== 'audio' || added.startPpq !== 0) {
    throw new Error(`audio take was not imported at bar one: ${JSON.stringify(added)}`);
  }
  return added;
}

export async function run({ page, fail }) {
  await page.click('.dock-tabs button:has-text("Media")');
  const reference = await importAtStart(page, 'align-reference', 0.55);
  const take = await importAtStart(page, 'align-take', 0.5);
  if (reference.lengthPpq < take.lengthPpq) {
    fail(`reference cannot cover the take: ${JSON.stringify({ reference, take })}`);
  }

  await page.locator('.tool-palette .tool-button').first().click();
  const canvas = page.locator('.arrangement-canvas canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('arrangement canvas missing');
  const header = page.locator('.track-header').last();
  for (let attempt = 0; attempt < 10; attempt++) {
    const row = await header.boundingBox();
    if (row && row.y >= box.y + 28 && row.y + 20 < box.y + box.height) break;
    await page.mouse.move(box.x + 100, box.y + 160);
    await page.mouse.wheel(0, 180);
    await page.waitForTimeout(40);
  }
  const row = await header.boundingBox();
  if (!row || row.y < box.y + 28 || row.y + 20 >= box.y + box.height) {
    throw new Error('alternate take lane could not be revealed');
  }
  await page.mouse.click(box.x + 5, row.y + 20, { button: 'right' });
  const align = page.locator('.context-menu-item[data-menu-item-id="align-to"]');
  await align.waitFor({ state: 'visible' });
  if (await align.isDisabled())
    fail('reference alignment is disabled despite a covering audio clip');
  await align.hover();
  const target = page.locator(`.context-submenu [data-menu-item-id="align-to-${reference.id}"]`);
  await target.waitFor({ state: 'visible' });
  await target.click();
  await page.waitForFunction(
    (id) => window.__sonareDebug.clipSettings(id)?.warpEnabled === true,
    take.id,
    { timeout: 30000 },
  );
  console.info('alternate audio take aligned to a covering reference through the clip menu');
  await page.keyboard.press('Meta+z');
  await page.waitForFunction((id) => !window.__sonareDebug.clipSettings(id)?.warpEnabled, take.id);
}
