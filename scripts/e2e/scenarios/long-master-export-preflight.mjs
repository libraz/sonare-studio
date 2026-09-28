/** Long whole-song exports fail before rendering when mastering needs one WASM buffer. */
export const name = 'long-master-export-preflight';

export async function run({ page, baseUrl, fail }) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.locator('[data-testid="start-demo"]').click();
  await page.waitForFunction(() => window.__sonareDebug?.initialized() === true);
  if ((await page.evaluate(() => localStorage.getItem('sonare-studio.tourSeen'))) !== '1') {
    await page.locator('.tour-tooltip').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('.tour-skip').click();
    await page.locator('.tour-overlay').waitFor({ state: 'detached' });
  }
  await page.click('.dock-tabs button:has-text("Mastering")');
  await page.click('.mastering-panel .chain-add');
  await page
    .locator('.chain-catalog .catalog-item-label')
    .filter({ hasText: /^Tape$/ })
    .first()
    .click();
  const processors = await page.evaluate(() => window.__sonareDebug.masteringProcessors());
  if (!processors.includes('saturation.tape')) {
    throw new Error(
      `mastering chain is missing before long export check: ${JSON.stringify(processors)}`,
    );
  }
  const previousDownload = await page.evaluate(
    () => window.__sonareDebug.lastDownload()?.filename ?? null,
  );

  // Slow the existing demo's timeline without generating hours of PCM. Its
  // content stays unchanged, but its full-song master render exceeds the WASM
  // stereo input limit at the selected 48 kHz sample rate.
  await page.evaluate(() => window.__sonareDebug.setTempoSegments([{ startPpq: 0, bpm: 20 }]));
  try {
    await page.click('.app-menubar__trigger:has-text("File")');
    await page
      .locator('.menu-panel [role="menuitem"]')
      .filter({ hasText: /^Export Audio\.\.\.$/ })
      .click();
    await page.locator('.modal-card .export-button:not([disabled])').waitFor();
    await page.click('.modal-card .export-button');
    const alert = page.locator('.modal-card .dialog-error');
    await alert.waitFor({ state: 'visible', timeout: 15000 });
    const message = ((await alert.textContent()) ?? '').trim();
    if (!/loop|range/i.test(message) || !/master/i.test(message)) {
      fail(`long mastering export lacks an actionable range/chain choice: ${message}`);
    }
    if (/WASM Float32 input budget/i.test(message)) {
      fail(`long mastering export exposed the raw WASM error: ${message}`);
    }
    const latestDownload = await page.evaluate(
      () => window.__sonareDebug.lastDownload()?.filename ?? null,
    );
    if (latestDownload !== previousDownload) {
      fail('blocked long mastering export still published a download');
    }
    if (await page.locator('.modal-card .progress-track').isVisible()) {
      fail('blocked long mastering export entered the render stage');
    }
    await page.click('.modal-card .close-button');
    console.info('long mastering export stopped before rendering with a range/chain remedy');
  } finally {
    await page.evaluate(() => window.__sonareDebug.setTempoSegments([{ startPpq: 0, bpm: 120 }]));
  }
}
