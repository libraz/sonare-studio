/** Export dialog: WAV 16-bit mixdown download. */
export const name = 'export-dialog';

export async function run(ctx) {
  const { page, fail } = ctx;

  // Export the loop region rather than the whole project. The demo runs eight
  // minutes, so the default range renders an 84 MB file every time — minutes of
  // work to prove something two seconds of audio proves just as well, and the
  // range control goes untested either way. Setting a loop needs the engine,
  // which only exists once something has played, so a run that starts here
  // falls back to the whole project rather than failing on the range control.
  const looped = await page.evaluate(() => window.__sonareDebug.setLoopRange(0, 4, true));

  await page.click('.app-menubar__trigger:has-text("File")');
  await page
    .locator('.menu-panel [role="menuitem"]')
    .filter({ hasText: /^Export Audio\.\.\.$/ })
    .click();
  await page.waitForSelector('.modal-card .export-button:not([disabled])', { timeout: 10000 });
  // Otherwise the defaults stand: WAV / 16-bit / 48 kHz / master chain on.
  if (looped) {
    await page.click('.modal-card .range-loop');
    await page.waitForSelector('.modal-card .range-loop[aria-checked="true"]', { timeout: 5000 });
  } else {
    console.info('no engine yet: exporting the whole project instead of a loop region');
  }
  await page.click('.modal-card .export-button');
  try {
    await page.waitForSelector('.modal-card .export-report', { timeout: 120000 });
  } catch {
    // The dialog reports a refusal in its own alert rows; a bare timeout here
    // cannot tell "still rendering" from "declined before it started".
    const dialogState = await page.evaluate(() => ({
      errors: [...document.querySelectorAll('.modal-card .dialog-errors li')].map((el) =>
        (el.textContent ?? '').trim(),
      ),
      error: document.querySelector('.modal-card .dialog-error')?.textContent?.trim() ?? null,
      buttonDisabled: document.querySelector('.modal-card .export-button')?.disabled ?? null,
      progress: document.querySelector('.modal-card progress')?.value ?? null,
    }));
    throw new Error(`export produced no report: ${JSON.stringify(dialogState)}`);
  }
  const reportPeakText = (
    (await page.locator('.modal-card .report-peak').textContent()) ?? ''
  ).trim();
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
  await page.click('.modal-card .close-button');
  if (looped) await page.evaluate(() => window.__sonareDebug.setLoopRange(0, 4, false));
}
