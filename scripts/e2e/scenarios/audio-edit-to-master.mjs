import { makeWavBytes } from '../harness.mjs';
import { downloadBytes, inspectWav } from '../wav-inspection.mjs';

/** Finish an edited audio clip, reopen the session, and deliver the same master. */
export const name = 'audio-edit-to-master';
const PROJECT_NAME = 'DAW edited audio master';
const SOURCE_NAME = 'daw-asymmetric-performance';
const SECONDS = 2;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function performanceWav() {
  const bytes = makeWavBytes(SECONDS, 330, 48000, 0.65);
  // A continuous bed with a changing envelope distinguishes a reversed take
  // while leaving enough energy at both ends to witness arrangement fades.
  const frames = (bytes.length - 44) / 2;
  for (let index = 0; index < frames; index++) {
    const offset = 44 + index * 2;
    const envelope = 0.5 + 0.5 * (index / frames);
    bytes.writeInt16LE(Math.round(bytes.readInt16LE(offset) * envelope), offset);
  }
  return bytes;
}

async function openEmpty(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.locator('[data-testid="start-new"]').click();
  await page.locator('#new-project-template-empty').click();
  await page.locator('.modal-card:has(#new-project-template-empty) button.primary').click();
  await page.locator('.modal-scrim.is-launcher-layer').waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.__sonareDebug?.initialized() === true);
}

async function editSample(page) {
  await page.getByRole('tab', { name: 'Media', exact: true }).click();
  await page.locator('.media-browser .file-input').setInputFiles({
    name: `${SOURCE_NAME}.wav`,
    mimeType: 'audio/wav',
    buffer: performanceWav(),
  });
  const row = page.locator('.media-browser .asset-row').filter({ hasText: SOURCE_NAME });
  await row.waitFor({ timeout: 20000 });
  await row.locator('.add-button').click();
  await page.waitForFunction(() => window.__sonareDebug.clipCount() === 1);
  const clip = await page.evaluate(() => window.__sonareDebug.clipRanges()[0]);
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), clip.id);
  await page.getByRole('tab', { name: 'Sample', exact: true }).click();
  await page.locator('.sample-editor .wave-wrap').waitFor();
  await page.getByRole('tab', { name: 'Edit', exact: true }).click();
  const editPanel = page.getByRole('tabpanel', { name: 'Edit', exact: true });
  for (const [index, operation] of ['reverse', 'normalize'].entries()) {
    const button =
      operation === 'reverse'
        ? editPanel.getByRole('button', { name: 'Reverse', exact: true })
        : editPanel
            .locator('.op-cluster')
            .filter({ hasText: 'Normalize' })
            .getByRole('button', { name: 'Apply', exact: true });
    await button.click();
    await page.waitForFunction(
      (count) => document.querySelectorAll('.sample-editor .history-entry').length === count,
      index + 2,
      { timeout: 30000 },
    );
    if (index === 0) {
      const confirmation = page.locator('.modal-card:has(.dialog-message)');
      await confirmation.waitFor({ timeout: 30000 });
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
      await confirmation.waitFor({ state: 'hidden' });
    }
  }
  assert(
    (await page.locator('.sample-editor .history-entry').count()) === 3,
    'Reverse and Normalize did not each produce a sample version',
  );
  await page.locator('.sample-editor .toolbar button', { hasText: 'Use in project' }).click();
  const fields = page.locator('.clip-inspector .ci-field input');
  await fields.nth(0).fill('-3');
  await fields.nth(0).press('Tab');
  for (const index of [1, 2]) {
    await fields.nth(index).fill('0.5');
    await fields.nth(index).press('Tab');
  }
  const settings = await page.evaluate(() => {
    const current = window.__sonareDebug.clipRanges()[0];
    return window.__sonareDebug.clipSettings(current.id);
  });
  assert(
    settings &&
      Math.abs(settings.gain - 10 ** (-3 / 20)) < 0.001 &&
      settings.fadeInPpq === 0.5 &&
      settings.fadeOutPpq === 0.5,
    `Arrangement gain/fades did not reach the audio clip: ${JSON.stringify(settings)}`,
  );
  return settings;
}

async function downloadWav(page, includeMaster) {
  await page.locator('#menubar-trigger-file').click();
  await page.locator('[id="menubar-file-file_2e_exportAudio"]').click();
  const dialog = page.locator('.modal-card:has(.export-button)');
  await dialog.waitFor();
  await dialog.locator('.wav-bit-depth [role="combobox"]').click();
  await page.getByRole('option', { name: '32-bit float', exact: true }).click();
  const master = dialog.locator('.include-master-chain');
  if ((await master.getAttribute('aria-pressed')) !== String(includeMaster)) await master.click();
  const normalize = dialog.locator('.normalize-loudness');
  if ((await normalize.getAttribute('aria-pressed')) === 'true') await normalize.click();
  await dialog.locator('.release-tail-input').fill('0');
  const pending = page.waitForEvent('download', { timeout: 60000 });
  await dialog.locator('.export-button').click();
  const download = await pending;
  assert(download.suggestedFilename().endsWith('.wav'), 'Audio delivery is not a WAV file');
  const wav = inspectWav(await downloadBytes(download));
  await dialog.locator('.export-report').waitFor({ timeout: 60000 });
  await dialog.locator('.close-button').click();
  await dialog.waitFor({ state: 'hidden' });
  assert(
    wav.format === 3 &&
      wav.bitsPerSample === 32 &&
      wav.channels === 2 &&
      wav.sampleRate === 48000 &&
      Math.abs(wav.durationSeconds - SECONDS) < 0.001 &&
      wav.rms > 0.01,
    `Invalid finished WAV: ${JSON.stringify({ frames: wav.frames, rms: wav.rms, duration: wav.durationSeconds })}`,
  );
  return wav;
}

function windowRms(wav, startSeconds, endSeconds) {
  const start = Math.round(startSeconds * wav.sampleRate) * wav.channels;
  const end = Math.round(endSeconds * wav.sampleRate) * wav.channels;
  let energy = 0;
  for (let index = start; index < end; index++) energy += wav.samples[index] ** 2;
  return Math.sqrt(energy / (end - start));
}

async function configureMaster(page) {
  await page.getByRole('tab', { name: 'Mastering', exact: true }).click();
  await page.locator('.mastering-panel .preset-button').click();
  await page
    .locator('.mastering-panel .preset-item')
    .filter({ hasText: 'Streaming' })
    .first()
    .click();
  const ceiling = page.locator('[data-preset-control="loudness.ceilingDbtp"] input');
  await ceiling.fill('-6');
  await ceiling.press('Tab');
  assert((await ceiling.inputValue()) === '-6', 'Mastering ceiling did not accept -6 dB');
}

async function saveAndReopen(page) {
  await page.locator('#menubar-trigger-file').click();
  await page.locator('[id="menubar-file-file_2e_saveAs"]').click();
  const prompt = page.locator('.modal-card:has(.dialog-input)');
  await prompt.locator('.dialog-input').fill(PROJECT_NAME);
  await prompt.locator('button.primary').click();
  await page.locator('.dirty-dot').waitFor({ state: 'detached', timeout: 20000 });
  await page.waitForFunction((name) => window.__sonareDebug.projectName() === name, PROJECT_NAME);
  await page.reload({ waitUntil: 'load' });
  const project = page.locator('.ss-project').filter({ hasText: PROJECT_NAME });
  await project.waitFor({ timeout: 30000 });
  await project.click();
  await page.locator('.modal-scrim.is-launcher-layer').waitFor({ state: 'detached' });
  await page.waitForFunction((name) => window.__sonareDebug.projectName() === name, PROJECT_NAME);
}

export async function run({ page: sharedPage, baseUrl }) {
  const context = await sharedPage
    .context()
    .browser()
    .newContext({
      viewport: { width: 1440, height: 1100 },
    });
  // This production session belongs to a returning user who has completed the tour.
  await context.addInitScript(() => localStorage.setItem('sonare-studio.tourSeen', '1'));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await openEmpty(page, baseUrl);
    const clipSettings = await editSample(page);
    await page.locator('.transport-key.play').click();
    await page.waitForFunction(() => window.__sonareDebug.positionPpq() > 0.2);
    await page.locator('.transport-key.stop').click();
    const dry = await downloadWav(page, false);
    const edgeIn = windowRms(dry, 0, 0.025);
    const edgeOut = windowRms(dry, SECONDS - 0.025, SECONDS);
    const body = windowRms(dry, 0.8, 1.2);
    assert(
      edgeIn < body * 0.2 && edgeOut < body * 0.2,
      'Both arrangement fades must attenuate the delivered PCM',
    );
    const early = windowRms(dry, 0.35, 0.55);
    const late = windowRms(dry, 1.45, 1.65);
    assert(early > late * 1.3, 'Reverse did not invert the source amplitude envelope');
    assert(
      body > 0.31 && body < 0.36,
      `Normalize and clip gain did not produce the expected delivered level: ${body}`,
    );
    await configureMaster(page);
    const mastered = await downloadWav(page, true);
    assert(mastered.pcmHash !== dry.pcmHash, 'Mastering did not affect the actual downloaded PCM');
    assert(
      mastered.peak <= 10 ** (-6 / 20) + 0.01,
      `Master exceeds the requested ceiling: ${mastered.peak}`,
    );
    const before = await page.evaluate(() => window.__sonareDebug.projectDocument());
    await saveAndReopen(page);
    const after = await page.evaluate(() => window.__sonareDebug.projectDocument());
    assert(
      JSON.stringify(after.tracks) === JSON.stringify(before.tracks),
      'Edited audio clip or asset changed after reopening',
    );
    await page.getByRole('tab', { name: 'Mastering', exact: true }).click();
    assert(
      (await page.locator('[data-preset-control="loudness.ceilingDbtp"] input').inputValue()) ===
        '-6',
      'Mastering ceiling did not survive reopening',
    );
    const reopened = await downloadWav(page, true);
    assert(reopened.pcmHash === mastered.pcmHash, 'Reopening changed the delivered mastered PCM');
    assert(errors.length === 0, `Browser errors during production: ${errors.join('; ')}`);
    console.info(
      `audio edit to master: ${dry.frames} frames; fades RMS ${edgeIn.toFixed(4)}/${edgeOut.toFixed(4)} vs body ${body.toFixed(4)}; dry ${dry.pcmHash.slice(0, 12)} -> master/reopen ${mastered.pcmHash.slice(0, 12)}; gain ${clipSettings.gain.toFixed(3)}`,
    );
  } finally {
    await context.close();
  }
}
