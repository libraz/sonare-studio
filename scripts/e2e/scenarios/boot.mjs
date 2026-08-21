/** Boot: open the demo, assert isolation, dismiss the tour. */
export const name = 'boot';

export async function run(ctx) {
  const { page, fail, baseUrl } = ctx;
  await page.goto(baseUrl, { waitUntil: 'load' });

  // The shell boots into the start screen rather than auto-loading content;
  // open the bundled demo song to seed an editable project.
  await page.waitForSelector('[data-testid="start-demo"]', { timeout: 30000 });
  await page.click('[data-testid="start-demo"]');
  await page.waitForFunction(
    () => window.__sonareDebug?.initialized() === true && window.__sonareDebug.noteCount() > 0,
    null,
    { timeout: 30000 },
  );
  // The demo carries a rubato tempo map; flatten it to a constant 120 BPM so the
  // timing-sensitive scenarios below stay deterministic.
  await page.evaluate(() => window.__sonareDebug.setTempoSegments([{ startPpq: 0, bpm: 120 }]));
  await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
    timeout: 20000,
  });
  const seededCount = await page.evaluate(() => window.__sonareDebug.noteCount());
  const demoTrackCount = await page.evaluate(() => window.__sonareDebug.trackCount());
  console.info(`demo loaded, seeded notes: ${seededCount}, tracks: ${demoTrackCount}`);

  // The app must be cross-origin isolated (COOP/COEP) so SharedArrayBuffer
  // and the realtime engine's shared-memory transport are available.
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated === true);
  if (!isolated) {
    fail('crossOriginIsolated is not true (COOP/COEP headers missing)');
  } else {
    console.info('crossOriginIsolated: true');
  }

  // First run: the welcome tour auto-opens. Skip it (which stores the seen
  // flag, keeping it away after reloads) before driving the canvases below.
  await page.waitForSelector('.tour-tooltip', { timeout: 10000 });
  await page.click('.tour-tooltip .tour-skip');
  await page.waitForSelector('.tour-overlay', { state: 'detached', timeout: 5000 });
  const tourSeen = await page.evaluate(() => localStorage.getItem('sonare-studio.tourSeen'));
  if (tourSeen !== '1') {
    fail(`welcome tour seen flag not stored: ${JSON.stringify(tourSeen)}`);
  } else {
    console.info('welcome tour auto-opened on first run and was dismissed');
  }

  ctx.state.seededCount = seededCount;
  ctx.state.demoTrackCount = demoTrackCount;
}
