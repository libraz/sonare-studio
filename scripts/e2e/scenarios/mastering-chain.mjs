/** Mastering tab: add processors to the project mastering chain. */
export const name = 'mastering-chain';

export async function run(ctx) {
  const { page, fail } = ctx;

  await page.click('.dock-tabs button:has-text("Mastering")');
  await page.waitForSelector('.mastering-panel .chain-add', { timeout: 10000 });

  // A named preset exposes the same compact controls a mastering engineer
  // uses for an offline render. Edit two values, switch tabs to remount the
  // panel, then reset one value to prove the command-backed state persists.
  await page.click('.mastering-panel .preset-button');
  await page.waitForSelector('.mastering-panel .preset-menu', { timeout: 10000 });
  const streamingPreset = page
    .locator('.mastering-panel .preset-item')
    .filter({ hasText: 'Streaming' })
    .first();
  if ((await streamingPreset.count()) !== 1) {
    fail('streaming mastering preset is missing from the catalog');
  } else {
    await streamingPreset.click();
  }
  // The assistant now starts from the selected preset and returns measured
  // adjustments; it no longer picks a genre. Exercise the real WASM analysis
  // and assert the named base appears in the UI after the preview render.
  await page.click('.mastering-panel .assist-button');
  await page.waitForSelector('.mastering-panel .assist-result .assist-chip-name', {
    timeout: 60000,
  });
  const assistantBase = await page
    .locator('.mastering-panel .assist-result .assist-chip-name')
    .textContent();
  if (!assistantBase?.includes('Streaming')) {
    fail(`assistant did not use the selected Streaming preset: ${assistantBase}`);
  }
  // PPQ is quarter-note ticks; 8 ticks is a short, audible probe and keeps
  // the worker render comfortably within libsonare's Float32 input budget.
  const presetProbeRange = { startPpq: 0, endPpq: 8 };
  const presetBefore = await page.evaluate(
    (range) => window.__sonareDebug.exportProbe(true, range),
    presetProbeRange,
  );
  const targetLufs = page.locator(
    '.mastering-panel [data-preset-control="loudness.targetLufs"] input',
  );
  const ceilingDb = page.locator(
    '.mastering-panel [data-preset-control="loudness.ceilingDb"] input',
  );
  const denoiseEnabled = page.locator(
    '.mastering-panel [data-preset-control="repair.denoise.enabled"] input',
  );
  if (await denoiseEnabled.isChecked()) {
    fail('streaming preset unexpectedly enables denoise by default');
  }
  const reductionDb = page.locator(
    '.mastering-panel [data-preset-control="repair.denoise.reductionDb"] input',
  );
  await reductionDb.fill('80');
  await reductionDb.press('Tab');
  if (await denoiseEnabled.isChecked()) {
    fail('editing denoise reduction implicitly enabled the stage');
  }
  const presetReductionOnly = await page.evaluate(
    (range) => window.__sonareDebug.exportProbe(true, range),
    presetProbeRange,
  );
  if (presetBefore.hash !== presetReductionOnly.hash) {
    fail(
      `disabled denoise reduction changed rendered WAV: ${presetBefore.hash} vs ${presetReductionOnly.hash}`,
    );
  } else {
    console.info('disabled denoise reduction kept the rendered WAV unchanged');
  }
  await denoiseEnabled.check();
  if (!(await denoiseEnabled.isChecked())) fail('denoise enable control did not persist');
  const presetEnabled = await page.evaluate(
    (range) => window.__sonareDebug.exportProbe(true, range),
    presetProbeRange,
  );
  if (presetEnabled.hash === presetReductionOnly.hash) {
    fail(`enabling denoise did not change rendered WAV: ${presetEnabled.hash}`);
  } else {
    console.info(
      `denoise changed rendered WAV after enable: ${presetReductionOnly.hash} vs ${presetEnabled.hash}`,
    );
  }
  // Resetting the stage switch must not let the remaining reduction override
  // implicitly re-enable denoise inside libsonare.
  await page
    .locator(
      '.mastering-panel [data-preset-control="repair.denoise.enabled"] .preset-control-reset',
    )
    .click();
  if (await denoiseEnabled.isChecked()) {
    fail('resetting denoise enable did not restore the disabled preset state');
  }
  const presetEnableReset = await page.evaluate(
    (range) => window.__sonareDebug.exportProbe(true, range),
    presetProbeRange,
  );
  if (presetEnableReset.hash !== presetReductionOnly.hash) {
    fail(
      `resetting denoise enable left the stage active: ${presetReductionOnly.hash} vs ${presetEnableReset.hash}`,
    );
  }
  await denoiseEnabled.check();
  await targetLufs.fill('-9');
  await targetLufs.press('Tab');
  await ceilingDb.fill('-6');
  await ceilingDb.press('Tab');
  if ((await targetLufs.inputValue()) !== '-9' || (await ceilingDb.inputValue()) !== '-6') {
    fail('typed mastering preset controls did not accept the edited values');
  }
  if (
    presetBefore.riff !== 'RIFF' ||
    presetReductionOnly.riff !== 'RIFF' ||
    presetEnabled.riff !== 'RIFF' ||
    presetBefore.totalFrames <= 0 ||
    !(presetBefore.peakDb > -40)
  ) {
    fail(
      `preset controls did not produce an audible WAV: ${JSON.stringify({ presetBefore, presetReductionOnly, presetEnabled })}`,
    );
  }
  await page.click('.dock-tabs button:has-text("Mixer")');
  await page.waitForSelector('.mixer-strips .channel-strip', { timeout: 10000 });
  await page.click('.dock-tabs button:has-text("Mastering")');
  await page.waitForSelector('.mastering-panel .chain-add', { timeout: 10000 });
  const remountedTarget = page.locator(
    '.mastering-panel [data-preset-control="loudness.targetLufs"] input',
  );
  const remountedCeiling = page.locator(
    '.mastering-panel [data-preset-control="loudness.ceilingDb"] input',
  );
  if (
    (await remountedTarget.inputValue()) !== '-9' ||
    (await remountedCeiling.inputValue()) !== '-6'
  ) {
    fail('preset control edits did not persist through panel remount');
  } else {
    console.info('preset target and ceiling persisted through panel remount');
  }
  await page
    .locator('.mastering-panel [data-preset-control="loudness.targetLufs"] .preset-control-reset')
    .click();
  if ((await remountedTarget.inputValue()) !== '-14') {
    fail(`preset target reset did not restore -14, got ${await remountedTarget.inputValue()}`);
  }
  // Keep the long-running export probe focused on the explicit mastering rack
  // below; the preset controls have already been exercised and verified above.
  await page.click('.mastering-panel .preset-button');
  await page.click('.mastering-panel .preset-item.none');

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

  // Exercise the actual mastering preview: render both variants, verify that
  // the browser reports a numeric monitor attenuation, toggle it off/on, and
  // switch A/B while playback is running. This proves the controls are wired
  // to an audible preview rather than merely rendering in the DOM.
  await page.click('.mastering-panel .preview-button');
  await page.waitForSelector('.mastering-panel .level-match-status', { timeout: 10000 });
  await page.waitForFunction(
    () => !document.querySelector('.mastering-panel .preview-progress'),
    null,
    { timeout: 30000 },
  );
  const initialLevelMatch = await page
    .locator('.mastering-panel .level-match-status')
    .textContent();
  if (!initialLevelMatch || !/A\s+-?\d+\.\d+ dB\s+·\s+B\s+-?\d+\.\d+ dB/.test(initialLevelMatch)) {
    fail(`preview did not produce a numeric level-match result: ${initialLevelMatch}`);
  } else {
    console.info(`preview level match: ${initialLevelMatch.trim()}`);
  }
  const levelMatchToggle = page.locator('.mastering-panel .level-match-toggle input');
  if (!(await levelMatchToggle.isChecked())) fail('level match is not enabled by default');
  await levelMatchToggle.uncheck();
  if (
    (await page.locator('.mastering-panel .level-match-status').textContent())?.trim() !== 'Off'
  ) {
    fail('level match did not turn off');
  }
  await levelMatchToggle.check();
  if (
    (await page.locator('.mastering-panel .level-match-status').textContent())?.trim() !==
    initialLevelMatch?.trim()
  ) {
    fail('level match did not restore its measured attenuation');
  }

  // Instrument the real Web Audio graph. The two BufferSourceNodes must share
  // one scheduled start time, and selecting B must only schedule GainNode
  // ramps. This catches an offset based restart that a DOM assertion cannot
  // distinguish from a genuinely synchronized A/B monitor.
  await page.evaluate(() => {
    const audioContext = window.AudioContext;
    const probe = {
      available: Boolean(audioContext),
      starts: [],
      ramps: [],
    };
    window.__sonarePreviewProbe = probe;
    if (!audioContext) return;

    const createBufferSource = audioContext.prototype.createBufferSource;
    audioContext.prototype.createBufferSource = function () {
      const source = createBufferSource.call(this);
      const start = source.start.bind(source);
      source.start = (...args) => {
        const [when = 0, offset = 0] = args;
        probe.starts.push({ when, offset });
        return start(...args);
      };
      return source;
    };

    const createGain = audioContext.prototype.createGain;
    audioContext.prototype.createGain = function () {
      const gain = createGain.call(this);
      const parameter = gain.gain;
      const setValueAtTime = parameter.setValueAtTime.bind(parameter);
      const linearRampToValueAtTime = parameter.linearRampToValueAtTime.bind(parameter);
      parameter.setValueAtTime = (value, when) => {
        probe.ramps.push({ kind: 'set', value, when });
        return setValueAtTime(value, when);
      };
      parameter.linearRampToValueAtTime = (value, when) => {
        probe.ramps.push({ kind: 'ramp', value, when });
        return linearRampToValueAtTime(value, when);
      };
      return gain;
    };
  });
  await page.click('.mastering-panel .play-button');
  await page.waitForFunction(
    () => document.querySelector('.mastering-panel .play-button')?.textContent?.includes('Stop'),
    null,
    { timeout: 5000 },
  );
  const initialPlaybackProbe = await page.evaluate(() => window.__sonarePreviewProbe);
  if (
    !initialPlaybackProbe?.available ||
    initialPlaybackProbe.starts.length !== 2 ||
    initialPlaybackProbe.starts[0].when !== initialPlaybackProbe.starts[1].when
  ) {
    fail(`A/B sources were not synchronized: ${JSON.stringify(initialPlaybackProbe)}`);
  }
  await page.click('.mastering-panel .ab-button:nth-of-type(2)');
  await page.waitForFunction(
    () => document.querySelector('.mastering-panel .ab-button.active')?.textContent?.trim() === 'B',
    null,
    { timeout: 5000 },
  );
  await page.waitForFunction(
    () => window.__sonarePreviewProbe?.ramps.some((event) => event.kind === 'ramp'),
    null,
    { timeout: 5000 },
  );
  const switchedPlaybackProbe = await page.evaluate(() => window.__sonarePreviewProbe);
  const measuredDb = initialLevelMatch.match(/A\s+(-?\d+\.\d+) dB\s+·\s+B\s+(-?\d+\.\d+) dB/);
  const expectedBypassedGain = measuredDb ? 0.8 * 10 ** (Number(measuredDb[2]) / 20) : Number.NaN;
  // The UI intentionally displays one decimal dB, so allow the corresponding
  // small linear-gain rounding interval in the browser probe.
  const bypassRamp = switchedPlaybackProbe?.ramps.find(
    (event) => event.kind === 'ramp' && Math.abs(event.value - expectedBypassedGain) < 0.005,
  );
  if (
    switchedPlaybackProbe?.starts.length !== 2 ||
    !Number.isFinite(expectedBypassedGain) ||
    !bypassRamp
  ) {
    fail(
      `A/B switch did not ramp the measured bypass gain without restarting: ${JSON.stringify({ switchedPlaybackProbe, expectedBypassedGain })}`,
    );
  }
  const playbackEvidence = await page.evaluate(() => ({
    activeVariant: document
      .querySelector('.mastering-panel .ab-button.active')
      ?.textContent?.trim(),
    playing: document.querySelector('.mastering-panel .play-button')?.textContent?.includes('Stop'),
  }));
  if (playbackEvidence.activeVariant !== 'B' || !playbackEvidence.playing) {
    fail(
      `A/B preview did not remain playable after switching: ${JSON.stringify(playbackEvidence)}`,
    );
  } else {
    console.info('preview playback switched to B while remaining active');
  }
  await page.click('.mastering-panel .play-button');

  // Real-wasm export probe: the worker render must be non-silent and the
  // master chain must change the encoded bytes. The first call initializes
  // the wasm inside the export worker.
  const probeOn = await page.evaluate(
    (range) => window.__sonareDebug.exportProbe(true, range),
    presetProbeRange,
  );
  const probeOff = await page.evaluate(
    (range) => window.__sonareDebug.exportProbe(false, range),
    presetProbeRange,
  );
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
