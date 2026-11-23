import { makeWavBytes, unzipSync } from '../harness.mjs';
import { downloadBytes, inspectWav } from '../wav-inspection.mjs';

/** Import three audio tracks, persist their mixer state, and verify mix/stem handoff. */
export const name = 'multitrack-stems-handoff';

const PROJECT_NAME = 'e2e-multitrack-stems-handoff';
const TRACKS = [
  { name: 'Alpha Source', frequencyHz: 233, gainDb: -6, pan: -0.75 },
  { name: 'Beta Source', frequencyHz: 377, gainDb: -12, pan: 0 },
  { name: 'Gamma Source', frequencyHz: 619, gainDb: -18, pan: 0.75 },
];

function makeSettledWavBytes(frequencyHz) {
  const sampleRate = 44100;
  const bytes = makeWavBytes(1.5, frequencyHz, sampleRate, 0.42);
  // Keep a short, real leading silence in the source so the offline engine's
  // startup parameter smoothing settles before the audible fixture begins.
  const leadingSilenceFrames = Math.round(sampleRate * 0.25);
  bytes.fill(0, 44, 44 + leadingSilenceFrames * 2);
  return bytes;
}

function sameNumber(left, right, tolerance = 0.02) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function freshPage(page) {
  const browser = page.context().browser();
  if (!browser) throw new Error('the E2E page has no browser owner');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  return { context, page: await context.newPage() };
}

async function skipTour(page) {
  const tour = page.locator('.tour-tooltip');
  if (await tour.isVisible().catch(() => false)) {
    await tour.locator('.tour-skip').click();
    await page.locator('.tour-overlay').waitFor({ state: 'detached', timeout: 10000 });
  }
}

async function createEmptyProject(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.locator('[data-testid="start-new"]').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('[data-testid="start-new"]').click();
  await page.locator('#new-project-template-empty').click();
  await page
    .locator('.modal-card:has(#new-project-template-empty) .modal-foot button.primary')
    .click();
  await page.locator('.modal-scrim.is-launcher-layer').waitFor({ state: 'detached' });
  await page.locator('.arrangement-canvas').waitFor({ state: 'visible', timeout: 30000 });
  await skipTour(page);
}

async function importTracks(page) {
  await page.locator('[id="editor-dock-tab-media"]').click();
  await page.locator('.media-browser .file-input').waitFor({ state: 'attached' });
  await page.setInputFiles(
    '.media-browser .file-input',
    TRACKS.map((track) => ({
      name: `${track.name}.wav`,
      mimeType: 'audio/wav',
      buffer: makeSettledWavBytes(track.frequencyHz),
    })),
  );

  for (const track of TRACKS) {
    const asset = page
      .locator('.media-browser .asset-row')
      .filter({
        has: page
          .locator('.asset-name')
          .filter({ hasText: new RegExp(`^${escapeRegex(track.name)}$`) }),
      })
      .first();
    await asset.waitFor({ state: 'visible', timeout: 30000 });
    await asset.locator('.add-button').click();
    await page
      .locator('.track-header .track-name')
      .filter({ hasText: new RegExp(`^${escapeRegex(track.name)}$`) })
      .waitFor({ state: 'visible', timeout: 30000 });
  }
}

function stripForName(page, name) {
  return page.locator('.mixer-strips .channel-strip').filter({
    has: page.locator('.strip-name').filter({ hasText: new RegExp(`^${escapeRegex(name)}$`) }),
  });
}

async function setReadout(strip, selector, value) {
  await strip.locator(selector).click();
  const input = strip.locator('input.numeric-readout-input');
  await input.waitFor({ state: 'visible' });
  await input.fill(String(value));
  await input.press('Enter');
  await input.waitFor({ state: 'hidden' });
}

async function configureMixer(page) {
  await page.locator('[id="editor-dock-tab-mixer"]').click();
  await page
    .locator('.mixer-strips .channel-strip')
    .first()
    .waitFor({ state: 'visible', timeout: 20000 });
  for (const track of TRACKS) {
    const strip = stripForName(page, track.name).first();
    await strip.waitFor({ state: 'visible', timeout: 20000 });
    await setReadout(strip, '.strip-readout', track.gainDb);
    await setReadout(strip, '.strip-pan .numeric-readout', track.pan);
    await page.waitForFunction(
      ({ name, gain, pan }) => {
        const strips = [...document.querySelectorAll('.mixer-strips .channel-strip')];
        const strip = strips.find(
          (entry) => entry.querySelector('.strip-name')?.textContent?.trim() === name,
        );
        const fader = strip?.querySelector('.fader-track')?.getAttribute('aria-valuenow');
        const knob = strip?.querySelector('.strip-pan .knob')?.getAttribute('aria-valuenow');
        return (
          fader !== null &&
          knob !== null &&
          Math.abs(Number(fader) - gain) < 0.02 &&
          Math.abs(Number(knob) - pan) < 0.02
        );
      },
      { name: track.name, gain: track.gainDb, pan: track.pan },
      { timeout: 10000 },
    );
  }
}

async function mixerState(page) {
  const state = {};
  for (const track of TRACKS) {
    const strip = stripForName(page, track.name).first();
    await strip.waitFor({ state: 'visible', timeout: 20000 });
    state[track.name] = {
      gain: await strip.locator('.fader-track').getAttribute('aria-valuenow'),
      pan: await strip.locator('.strip-pan .knob').getAttribute('aria-valuenow'),
    };
  }
  return state;
}

async function saveAs(page) {
  await page.locator('.app-menubar__trigger:has-text("File")').click();
  await page.locator('[id="menubar-file-file_2e_saveAs"]').click();
  const prompt = page.locator('.modal-card:has(.dialog-input)');
  await prompt.waitFor({ state: 'visible' });
  await prompt.locator('.dialog-input').fill(PROJECT_NAME);
  await prompt.locator('.modal-foot button.primary').click();
  await prompt.waitFor({ state: 'detached', timeout: 10000 });

  // The save either finishes or stops on an overwrite confirmation; wait for whichever comes.
  const overwrite = page.locator('.modal-card:has(.dialog-message)');
  await page.waitForFunction(
    () =>
      document.querySelector('.modal-card .dialog-message') !== null ||
      document.querySelector('.dirty-dot') === null,
    null,
    { timeout: 30000 },
  );
  if (await overwrite.isVisible()) {
    await overwrite.locator('.modal-foot button.primary').click();
    await overwrite.waitFor({ state: 'detached', timeout: 10000 });
  }
  await page.locator('.dirty-dot').waitFor({ state: 'detached', timeout: 30000 });
}

async function reopenSavedProject(page) {
  await page.reload({ waitUntil: 'load' });
  await page.locator('[data-testid="start-new"]').waitFor({ state: 'visible', timeout: 30000 });
  const saved = page.locator('.ss-project').filter({ hasText: PROJECT_NAME }).first();
  await saved.waitFor({ state: 'visible', timeout: 30000 });
  await saved.click();
  await page
    .locator('.modal-scrim.is-launcher-layer')
    .waitFor({ state: 'detached', timeout: 30000 });
  await page.locator('.arrangement-canvas').waitFor({ state: 'visible', timeout: 30000 });
  await skipTour(page);
  await page.locator('[id="editor-dock-tab-mixer"]').click();
  await page
    .locator('.mixer-strips .channel-strip')
    .first()
    .waitFor({ state: 'visible', timeout: 20000 });
}

async function openExportDialog(page) {
  await page.locator('.app-menubar__trigger:has-text("File")').click();
  await page
    .locator('.menu-panel [role="menuitem"]')
    .filter({ hasText: /^Export Audio\.\.\.$/ })
    .click();
  await page.locator('.modal-card .export-button').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('.modal-card .format-select .select-trigger').waitFor({ state: 'visible' });
}

async function selectWav32Float(page) {
  const trigger = page.locator('.modal-card .wav-bit-depth .select-trigger');
  await trigger.click();
  await page
    .locator('.select-list .select-option')
    .filter({ hasText: /^32-bit float$/ })
    .click();
  await page
    .locator('.modal-card .wav-bit-depth .select-value')
    .filter({ hasText: '32-bit float' })
    .waitFor();
}

async function setToggle(page, selector, desired) {
  const toggle = page.locator(`.modal-card ${selector}`);
  const pressed = (await toggle.getAttribute('aria-pressed')) === 'true';
  if (pressed !== desired) await toggle.click();
  await page.waitForFunction(
    ({ selector: css, desired: expected }) =>
      document.querySelector(`.modal-card ${css}`)?.getAttribute('aria-pressed') ===
      String(expected),
    { selector, desired },
  );
}

async function configureExport(page, mode, baseName) {
  await selectWav32Float(page);
  await page.locator(`.modal-card .mode-${mode}`).click();
  await page.locator(`.modal-card .mode-${mode}[aria-checked="true"]`).waitFor();
  await setToggle(page, '.include-master-chain', false);
  await setToggle(page, '.normalize-loudness', false);
  if (mode === 'stems') {
    await setToggle(page, '.include-master-stem', false);
    await setToggle(page, '.include-bus-stems', false);
  }
  await page.locator('#export-release-tail').fill('0');
  await page.locator('#export-filename').fill(baseName);
  await page
    .locator('.modal-card .export-button:not([disabled])')
    .waitFor({ state: 'visible', timeout: 10000 });
}

async function exportBytes(page, mode, baseName) {
  await openExportDialog(page);
  await configureExport(page, mode, baseName);
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('.modal-card .export-button').click();
  const download = await downloadPromise;
  const bytes = await downloadBytes(download);
  const filename = download.suggestedFilename();
  await page.locator('.modal-card .close-button').click();
  return { bytes, filename };
}

function semanticStemName(entry) {
  return entry.replace(/^\d+\s+/, '').replace(/\.wav$/i, '');
}

function inspectStems(zipBytes) {
  const archive = unzipSync(zipBytes);
  const entries = Object.entries(archive).filter(([entry]) => /\.wav$/i.test(entry));
  const actualNames = entries.map(([entry]) => semanticStemName(entry)).sort();
  const expectedNames = TRACKS.map((track) => track.name).sort();
  if (
    entries.length !== TRACKS.length ||
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames)
  ) {
    throw new Error(
      `track-only stems had unexpected entries: ${JSON.stringify(Object.keys(archive).sort())}`,
    );
  }
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entry, bytes]) => ({ entry, name: semanticStemName(entry), wav: inspectWav(bytes) }));
}

function assertWavSet(mix, stems) {
  const all = [mix, ...stems.map((stem) => stem.wav)];
  const reference = all[0];
  for (const wav of all) {
    if (wav.format !== 3 || wav.bitsPerSample !== 32 || wav.channels !== 2) {
      throw new Error(`expected stereo 32-bit float WAV: ${JSON.stringify(wav)}`);
    }
    if (
      wav.sampleRate !== 48000 ||
      wav.frames !== 72000 ||
      wav.sampleRate !== reference.sampleRate ||
      wav.frames !== reference.frames
    ) {
      throw new Error(`mix/stems timeline mismatch: ${JSON.stringify({ reference, wav })}`);
    }
    if (!(wav.frames > 0 && wav.peak > 0 && wav.rms > 0)) {
      throw new Error(`silent or empty WAV: ${JSON.stringify(wav)}`);
    }
  }
  const hashes = new Set([mix.pcmHash, ...stems.map((stem) => stem.wav.pcmHash)]);
  if (hashes.size !== stems.length + 1) throw new Error('mix/stem downloads are not PCM-distinct');

  const [alphaLeft, alphaRight] = stems[0].wav.channelRms;
  const [betaLeft, betaRight] = stems[1].wav.channelRms;
  const [gammaLeft, gammaRight] = stems[2].wav.channelRms;
  if (!(alphaLeft > alphaRight * 1.3)) {
    throw new Error(`left pan did not affect Alpha Source RMS: ${alphaLeft} vs ${alphaRight}`);
  }
  if (Math.abs(betaLeft - betaRight) > Math.max(betaLeft, betaRight) * 0.15) {
    throw new Error(`center pan did not preserve Beta Source balance: ${betaLeft} vs ${betaRight}`);
  }
  if (!(gammaRight > gammaLeft * 1.3)) {
    throw new Error(`right pan did not affect Gamma Source RMS: ${gammaLeft} vs ${gammaRight}`);
  }

  // Opposite, equally strong pans have the same energy attenuation, so
  // Alpha/Gamma must retain their 12 dB fader difference in delivered PCM.
  const outerRatio = stems[0].wav.rms / stems[2].wav.rms;
  const expectedRatio = 10 ** ((TRACKS[0].gainDb - TRACKS[2].gainDb) / 20);
  if (Math.abs(outerRatio / expectedRatio - 1) > 0.03) {
    throw new Error(
      `Fader gain missing from outer stems: ratio=${outerRatio}, expected=${expectedRatio}`,
    );
  }
  // Center pan preserves each channel's level. Compare Beta against the
  // independently generated input, rather than another renderer output.
  const sourceRms = inspectWav(makeSettledWavBytes(TRACKS[1].frequencyHz)).rms;
  const expectedCenterRms = sourceRms * 10 ** (TRACKS[1].gainDb / 20);
  if (Math.abs(stems[1].wav.rms / expectedCenterRms - 1) > 0.03) {
    throw new Error(
      `Center stem fader gain missing: actual=${stems[1].wav.rms}, expected=${expectedCenterRms}`,
    );
  }

  let maxError = 0;
  let squaredError = 0;
  const sampleCount = mix.samples.length;
  for (let index = 0; index < sampleCount; index += 1) {
    let sum = 0;
    for (const stem of stems) sum += stem.wav.samples[index];
    const error = mix.samples[index] - sum;
    maxError = Math.max(maxError, Math.abs(error));
    squaredError += error * error;
  }
  const rmsError = Math.sqrt(squaredError / sampleCount);
  if (maxError > 2e-5 || rmsError > 2e-6) {
    throw new Error(
      `mix is not the aligned sum of track stems: maxError=${maxError} rmsError=${rmsError}`,
    );
  }
  return { maxError, rmsError, sampleRate: mix.sampleRate, frames: mix.frames };
}

export async function run({ page, baseUrl, fail }) {
  const isolated = await freshPage(page);
  try {
    await createEmptyProject(isolated.page, baseUrl);
    await importTracks(isolated.page);
    await configureMixer(isolated.page);
    const beforeSave = await mixerState(isolated.page);
    await saveAs(isolated.page);
    await reopenSavedProject(isolated.page);
    const afterReload = await mixerState(isolated.page);
    for (const track of TRACKS) {
      const before = beforeSave[track.name];
      const after = afterReload[track.name];
      if (
        !before ||
        !after ||
        before.gain === null ||
        before.pan === null ||
        after.gain === null ||
        after.pan === null ||
        !sameNumber(before.gain, after.gain) ||
        !sameNumber(before.pan, after.pan)
      ) {
        fail(
          `mixer state was not preserved for ${track.name}: ${JSON.stringify({ before, after })}`,
        );
      }
    }
    console.info(`saved/reopened mixer state: ${JSON.stringify(afterReload)}`);

    const mixDownload = await exportBytes(isolated.page, 'mixdown', 'multitrack-stems-handoff-mix');
    const stemsDownload = await exportBytes(isolated.page, 'stems', 'multitrack-stems-handoff');
    if (!mixDownload.filename.endsWith('.wav'))
      fail(`mix export was not a WAV: ${mixDownload.filename}`);
    if (!stemsDownload.filename.endsWith('.zip'))
      fail(`stems export was not a ZIP: ${stemsDownload.filename}`);

    const mix = inspectWav(mixDownload.bytes);
    const stems = inspectStems(stemsDownload.bytes);
    const metrics = assertWavSet(mix, stems);
    console.info(
      `32-bit float mix/stems verified: ${metrics.sampleRate} Hz, ${metrics.frames} frames, ` +
        `stem hashes ${stems.map((stem) => `${stem.name}=${stem.wav.pcmHash.slice(0, 12)}`).join(', ')}, ` +
        `sum error max=${metrics.maxError} rms=${metrics.rmsError}`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    await isolated.context.close();
  }
}
