import { unzipSync } from '../harness.mjs';

/** DAWproject export: zip magic + project.xml entry. */
export const name = 'export-dawproject';

export async function run(ctx) {
  const { page, fail } = ctx;

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
}
