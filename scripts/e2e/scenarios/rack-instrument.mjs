/** Device rack: changing the instrument re-bounces the project. */
export const name = 'rack-instrument';

export async function run(ctx) {
  const { page, fail } = ctx;

  // Select the demo MIDI clip (lane 1 at PPQ 0) so the active track is MIDI.
  const arrangeBox3 = await page.locator('.arrangement-canvas').boundingBox();
  await page.mouse.click(arrangeBox3.x + 20, arrangeBox3.y + 28 + 28);
  await page.waitForFunction(() => window.__sonareDebug.activeClipId() !== -1, null, {
    timeout: 5000,
  });

  await page.click('.app-bar .devices-toggle');
  await page.waitForSelector('.device-rack .instrument-button', { timeout: 10000 });
  console.info('device rack opened for the active MIDI track');

  // Let the post-recording reschedule settle before capturing the baseline.
  await page.waitForFunction(
    () =>
      window.__sonareDebug.applyPending() === false &&
      window.__sonareDebug.scheduledClipIds().length > 0,
    null,
    { timeout: 20000 },
  );
  const midiClipCount = await page.evaluate(() => window.__sonareDebug.engineMidiClipCount());
  if (midiClipCount < 1) {
    fail(`expected MIDI clips in the engine schedule, got ${midiClipCount}`);
  } else {
    console.info(`engine holds ${midiClipCount} realtime MIDI clip schedule(s)`);
  }
  const idsBeforeInstrument = await page.evaluate(() =>
    JSON.stringify(window.__sonareDebug.scheduledClipIds()),
  );

  await page.click('.device-rack .instrument-button');
  await page.waitForSelector('.instrument-picker .preset-option', { timeout: 10000 });
  // Read the preset id from its own span: the option also carries a source
  // label, so the button's whole text is never the id the project stores.
  const presetName = await page.evaluate(() => {
    const names = [
      ...document.querySelectorAll('.instrument-picker .preset-option .preset-name'),
    ].map((el) => (el.textContent ?? '').trim());
    return names.find((name) => name === 'sawLead') ?? names.find((name) => name !== 'ePiano');
  });
  if (!presetName) {
    fail('no alternative synth preset offered by the instrument picker');
  } else {
    await page
      .locator('.instrument-picker .preset-option')
      .filter({ has: page.locator(`.preset-name:text-is("${presetName}")`) })
      .first()
      .click();
    await page.waitForFunction(
      (name) => window.__sonareDebug.trackInstruments().includes(name),
      presetName,
      { timeout: 10000 },
    );
    await page.waitForTimeout(400);
    const instrumentState = await page.evaluate(() => ({
      pending: window.__sonareDebug.applyPending(),
      ids: JSON.stringify(window.__sonareDebug.scheduledClipIds()),
    }));
    if (instrumentState.pending || instrumentState.ids !== idsBeforeInstrument) {
      fail(`instrument change caused a re-schedule: pending=${instrumentState.pending}`);
    }
    console.info(`instrument changed to "${presetName}" without re-scheduling (realtime synth)`);
  }

  // Two presets must render audibly different buffers through the real wasm.
  const probeA = await page.evaluate(() => window.__sonareDebug.renderProbe('ePiano'));
  const probeB = await page.evaluate(
    (name) => window.__sonareDebug.renderProbe(name),
    presetName ?? 'sawLead',
  );
  if (probeA.frames === 0 || probeB.frames === 0 || probeA.hash === probeB.hash) {
    fail(`presets render identical audio: ${JSON.stringify({ probeA, probeB })}`);
  } else {
    console.info(
      `render probe differs: ePiano ${probeA.hash} (peak ${probeA.peak.toFixed(4)}) vs ` +
        `${presetName} ${probeB.hash} (peak ${probeB.peak.toFixed(4)})`,
    );
  }
}
