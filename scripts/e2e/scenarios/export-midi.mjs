/** MIDI export: SMF + MIDI 2.0 clip-file downloads. */
export const name = 'export-midi';

export async function run(ctx) {
  const { page, fail } = ctx;

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
}
