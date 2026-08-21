/** Mastering tab: add processors to the project mastering chain. */
export const name = 'mastering-chain';

export async function run(ctx) {
  const { page, fail } = ctx;

  await page.click('.dock-tabs button:has-text("Mastering")');
  await page.waitForSelector('.mastering-panel .chain-add', { timeout: 10000 });
  // A brickwall limiter (rack add flow), plus tape saturation whose defaults
  // are audibly non-transparent so the chain provably changes the mixdown.
  for (const processorLabel of [/^Brickwall Limiter$/, /^Tape$/]) {
    await page.click('.mastering-panel .chain-add');
    await page.waitForSelector('.chain-catalog .catalog-item', { timeout: 10000 });
    await page
      .locator('.chain-catalog .catalog-item')
      .filter({ hasText: processorLabel })
      .first()
      .click();
  }
  const masteringChain = await page.evaluate(() => window.__sonareDebug.masteringProcessors());
  if (
    masteringChain.length !== 2 ||
    !masteringChain.includes('dynamics.brickwallLimiter') ||
    !masteringChain.includes('saturation.tape')
  ) {
    fail(`unexpected mastering chain: ${JSON.stringify(masteringChain)}`);
  } else {
    console.info(`mastering chain set: ${masteringChain.join(', ')}`);
  }

  // Real-wasm export probe: the worker render must be non-silent and the
  // master chain must change the encoded bytes. The first call initializes
  // the wasm inside the export worker.
  const probeOn = await page.evaluate(() => window.__sonareDebug.exportProbe(true));
  const probeOff = await page.evaluate(() => window.__sonareDebug.exportProbe(false));
  if (probeOn.riff !== 'RIFF' || probeOn.totalFrames <= 0 || !(probeOn.peakDb > -40)) {
    fail(`export probe not an audible WAV: ${JSON.stringify(probeOn)}`);
  } else if (probeOn.hash === probeOff.hash) {
    fail(`mastering chain has no effect on export bytes: ${probeOn.hash}`);
  } else {
    console.info(
      `export probe: peak ${probeOn.peakDb.toFixed(1)} dBFS, chain on/off bytes differ ` +
        `(${probeOn.hash} vs ${probeOff.hash})`,
    );
  }
}
