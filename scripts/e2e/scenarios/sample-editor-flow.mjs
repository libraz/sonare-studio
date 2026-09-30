/** Exercise the sample editor's worker edit, local history, and project apply. */
export const name = 'sample-editor-flow';

const SAMPLE_RATE = 12_000;
const ASSET_NAME = 'sonare-e2e-asymmetric-reverse';

/**
 * Build a deliberately asymmetric PCM fixture. A plain sine wave can look
 * unchanged after a reverse at this scale; this shape gives the worker a
 * short, unmistakable sequence to process.
 */
function asymmetricWavBytes() {
  const shape = [0.0, 0.72, -0.18, 0.94, -0.41, 0.11, -0.86, 0.33, 0.58, -0.07, 0.21, -0.63, 0.05];
  const frames = Math.round(SAMPLE_RATE * 0.25);
  const data = Buffer.alloc(frames * 2);
  for (let frame = 0; frame < frames; frame++) {
    const phase = frame % shape.length;
    const decay = 1 - (frame / frames) * 0.35;
    const sample = Math.max(-0.98, Math.min(0.98, shape[phase] * decay + (phase === 3 ? 0.04 : 0)));
    data.writeInt16LE(Math.round(sample * 32767), frame * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function resetProject(page) {
  await page.locator('button.app-menubar__trigger').filter({ hasText: 'File' }).click();
  await page.locator('.menu-panel').getByRole('menuitem', { name: 'New...', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  await dialog.locator('[role="option"]').filter({ hasText: 'Empty' }).click();
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForFunction(
    () =>
      window.__sonareDebug.initialized() &&
      window.__sonareDebug.trackCount() === 0 &&
      window.__sonareDebug.clipCount() === 0,
    null,
    { timeout: 20000 },
  );
}

async function importAudio(page) {
  await page.getByRole('tab', { name: 'Media', exact: true }).click();
  const before = await page.evaluate(() => window.__sonareDebug.clipRanges());
  await page.setInputFiles('.media-browser .file-input', {
    name: `${ASSET_NAME}.wav`,
    mimeType: 'audio/wav',
    buffer: asymmetricWavBytes(),
  });
  const asset = page.locator('.media-browser .asset-row', { hasText: ASSET_NAME }).last();
  await asset.waitFor({ state: 'visible', timeout: 20000 });
  await asset.locator('.add-button').click();
  await page.waitForFunction(
    (count) => window.__sonareDebug.clipCount() === count + 1,
    before.length,
    { timeout: 20000 },
  );
  const after = await page.evaluate(() => window.__sonareDebug.clipRanges());
  const clip = after.find((entry) => !before.some((existing) => existing.id === entry.id));
  if (clip?.kind !== 'audio')
    throw new Error(`asymmetric fixture was not added: ${JSON.stringify(clip)}`);
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), clip.id);
  return clip;
}

async function waitForSampleEditor(page) {
  await page.getByRole('tab', { name: 'Sample', exact: true }).click();
  await page.locator('.sample-editor .wave-wrap').waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForFunction(
    () => {
      const editor = document.querySelector('.sample-editor');
      const reverse = [...(editor?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent?.trim() === 'Reverse',
      );
      return Boolean(reverse && !reverse.disabled && !editor?.querySelector('.busy'));
    },
    null,
    { timeout: 30000 },
  );
}

async function cancelEditedAudioPrompt(page) {
  const prompt = page.locator('.modal-card:has(.dialog-message)');
  await prompt.waitFor({ state: 'visible', timeout: 20000 });
  const message = ((await prompt.locator('.dialog-message').textContent()) ?? '').trim();
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await prompt.waitFor({ state: 'hidden', timeout: 5000 });
  return message;
}

async function reverseAndCancelAutoApply(page, expectedHistoryLength) {
  const reverse = page.getByRole('button', { name: 'Reverse', exact: true });
  await reverse.click();
  await page.waitForFunction(
    (count) => document.querySelectorAll('.sample-editor .history-entry').length === count + 1,
    expectedHistoryLength,
    { timeout: 30000 },
  );
  await page.waitForFunction(
    () => document.querySelector('.sample-editor .asset-name')?.textContent?.includes('(edited)'),
    null,
    { timeout: 10000 },
  );
  return cancelEditedAudioPrompt(page);
}

async function projectJson(page) {
  return page.evaluate(() => JSON.stringify(window.__sonareDebug.projectDocument()));
}

async function exportFingerprint(page) {
  return page.evaluate(() => window.__sonareDebug.exportProbe(false));
}

export async function run({ page, fail }) {
  await resetProject(page);
  const clip = await importAudio(page);
  await waitForSampleEditor(page);

  const originalProject = await projectJson(page);
  const originalPcm = await exportFingerprint(page);
  const originalIsValid =
    originalPcm.riff === 'RIFF' &&
    Number.isInteger(originalPcm.totalFrames) &&
    originalPcm.totalFrames > 0 &&
    originalPcm.wavBytes > 44 &&
    Number.isFinite(originalPcm.peakDb) &&
    originalPcm.peakDb > -90;
  if (!originalIsValid) {
    fail(`original export was not a nonzero RIFF: ${JSON.stringify(originalPcm)}`);
  }
  const initialHistory = await page.locator('.sample-editor .history-entry').count();
  if (initialHistory !== 1) {
    fail(`expected one original sample version, got ${initialHistory}`);
  }

  const firstPrompt = await reverseAndCancelAutoApply(page, initialHistory);
  const afterCancelledApply = await projectJson(page);
  const afterCancelledPcm = await exportFingerprint(page);
  if (afterCancelledApply !== originalProject || afterCancelledPcm.hash !== originalPcm.hash) {
    fail(
      `cancelled worker edit changed project audio: ${JSON.stringify({
        clip,
        firstPrompt,
        originalHash: originalPcm.hash,
        afterCancelledHash: afterCancelledPcm.hash,
      })}`,
    );
  }

  // The waveform owns Cmd/Ctrl+Z. This must return to the original asset while
  // leaving the arrangement document byte-for-byte unchanged.
  await page.locator('.sample-editor .wave-wrap').focus();
  const undoKey = await page.evaluate(() =>
    /Mac/i.test(navigator.platform) ? 'Meta+z' : 'Control+z',
  );
  await page.keyboard.press(undoKey);
  await page.waitForFunction(
    () => {
      const entries = document.querySelectorAll('.sample-editor .history-entry');
      return (
        entries.length === 2 &&
        entries[0].classList.contains('current') &&
        !entries[1].classList.contains('current')
      );
    },
    null,
    { timeout: 10000 },
  );
  const afterLocalUndo = await projectJson(page);
  if (afterLocalUndo !== originalProject) {
    fail('sample-editor Undo touched the project history');
  }

  // Re-run the real worker operation, decline its automatic apply prompt, and
  // use the explicit toolbar action so project Undo can be checked separately.
  await waitForSampleEditor(page);
  const secondPrompt = await reverseAndCancelAutoApply(page, 1);
  const editedAssetName = (await page.locator('.sample-editor .asset-name').textContent())?.trim();
  if (!editedAssetName?.includes('(edited)')) {
    fail(
      `reverse did not select an edited asset: ${JSON.stringify({ editedAssetName, secondPrompt })}`,
    );
  }
  await page
    .locator('.sample-editor .toolbar')
    .first()
    .locator('button', { hasText: 'Use in project' })
    .click();
  await page.waitForFunction(
    (before) => JSON.stringify(window.__sonareDebug.projectDocument()) !== before,
    originalProject,
    { timeout: 10000 },
  );
  const appliedProject = await projectJson(page);
  const appliedPcm = await exportFingerprint(page);
  if (appliedPcm.hash === originalPcm.hash) {
    fail(
      `project Apply left the rendered PCM unchanged: ${JSON.stringify({
        originalHash: originalPcm.hash,
        appliedHash: appliedPcm.hash,
      })}`,
    );
  }

  const projectUndo = page.locator('button.undo-toggle');
  await page.waitForFunction(() => !document.querySelector('button.undo-toggle')?.disabled, null, {
    timeout: 10000,
  });
  await projectUndo.click();
  await page.waitForFunction(
    (before) => JSON.stringify(window.__sonareDebug.projectDocument()) === before,
    originalProject,
    { timeout: 10000 },
  );
  const restoredProject = await projectJson(page);
  const restoredPcm = await exportFingerprint(page);
  if (restoredProject !== originalProject || restoredPcm.hash !== originalPcm.hash) {
    fail('project Undo did not restore the original audio clip');
  }
  console.info(
    `sample editor worker reverse completed for asymmetric ${SAMPLE_RATE}Hz WAV; PCM hash ${originalPcm.hash} -> ${appliedPcm.hash} -> ${restoredPcm.hash}, local Undo preserved the project, and project Undo restored it (${appliedProject.length} JSON chars)`,
  );
}
