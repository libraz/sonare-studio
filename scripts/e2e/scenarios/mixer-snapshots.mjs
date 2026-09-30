/** Exercise mixer snapshot A/B recall, undo, and overwrite cancellation. */
export const name = 'mixer-snapshots';

const SNAPSHOT_A = { gainDb: -6, mute: true };
const SNAPSHOT_B = { gainDb: -12, mute: false };

async function resetProject(page) {
  await page.locator('button.app-menubar__trigger').filter({ hasText: 'File' }).click();
  await page.locator('.menu-panel').getByRole('menuitem', { name: 'New...', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  await dialog.locator('[role="option"]').filter({ hasText: 'Transcription' }).click();
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForFunction(
    () =>
      window.__sonareDebug.initialized() &&
      window.__sonareDebug.trackCount() === 1 &&
      window.__sonareDebug.clipCount() === 1,
    null,
    { timeout: 20000 },
  );
}

async function mixerState(page) {
  return page.evaluate(() => {
    const document = window.__sonareDebug.projectDocument();
    const track = document?.tracks?.[0];
    return { gainDb: track?.mixer?.gainDb ?? null, mute: track?.mute ?? null };
  });
}

async function waitMixerState(page, expected, label) {
  await page.waitForFunction(
    ({ gainDb, mute }) => {
      const document = window.__sonareDebug.projectDocument();
      const track = document?.tracks?.[0];
      const actualGain = track?.mixer?.gainDb;
      return (
        typeof actualGain === 'number' &&
        Math.abs(actualGain - gainDb) < 0.05 &&
        track?.mute === mute
      );
    },
    expected,
    { timeout: 10000 },
  );
  const actual = await mixerState(page);
  if (
    typeof actual.gainDb !== 'number' ||
    Math.abs(actual.gainDb - expected.gainDb) >= 0.05 ||
    actual.mute !== expected.mute
  ) {
    throw new Error(
      `${label} state mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
  return actual;
}

async function setGain(page, strip, gainDb) {
  const readout = strip.locator('.strip-readout.numeric-readout');
  await readout.click();
  const input = strip.locator('.strip-readout.numeric-readout-input');
  await input.waitFor({ state: 'visible', timeout: 5000 });
  await input.fill(String(gainDb));
  await input.press('Enter');
  await page.waitForFunction(
    (expected) => {
      const document = window.__sonareDebug.projectDocument();
      const actual = document?.tracks?.[0]?.mixer?.gainDb;
      return typeof actual === 'number' && Math.abs(actual - expected) < 0.05;
    },
    gainDb,
    { timeout: 10000 },
  );
}

async function setMute(strip, mute) {
  const button = strip.locator('button.toggle.mute');
  const current = (await button.getAttribute('aria-pressed')) === 'true';
  if (current !== mute) await button.click();
}

async function storeSnapshot(page, slotIndex) {
  const slot = page.locator('.mixer-panel .snapshot-slot').nth(slotIndex);
  await slot.locator('.snapshot-store').click();
  await page.waitForFunction(
    (index) => {
      const button = document
        .querySelectorAll('.mixer-panel .snapshot-slot')
        [index]?.querySelector('.snapshot-recall');
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    slotIndex,
    { timeout: 10000 },
  );
  return slot;
}

async function cancelOverwritePrompt(page) {
  const prompt = page.locator('.modal-card:has(.dialog-message)');
  await prompt.waitFor({ state: 'visible', timeout: 5000 });
  const message = ((await prompt.locator('.dialog-message').textContent()) ?? '').trim();
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await prompt.waitFor({ state: 'hidden', timeout: 5000 });
  return message;
}

export async function run({ page, fail }) {
  await resetProject(page);
  await page.getByRole('tab', { name: 'Mixer', exact: true }).click();
  await page.locator('.mixer-panel .mixer-strips .channel-strip').first().waitFor({
    state: 'visible',
    timeout: 10000,
  });

  const strip = page.locator('.mixer-panel .mixer-strips .channel-strip:not(.master)').first();
  await strip.waitFor({ state: 'visible', timeout: 10000 });
  const initialDocument = await page.evaluate(() => window.__sonareDebug.projectDocument());
  if (!initialDocument?.tracks?.length) {
    fail('mixer has no project track to snapshot');
  }

  await setGain(page, strip, SNAPSHOT_A.gainDb);
  await setMute(strip, SNAPSHOT_A.mute);
  const slotA = await storeSnapshot(page, 0);
  const stateA = await waitMixerState(page, SNAPSHOT_A, 'snapshot A store');

  await setGain(page, strip, SNAPSHOT_B.gainDb);
  await setMute(strip, SNAPSHOT_B.mute);
  const slotB = await storeSnapshot(page, 1);
  const stateB = await waitMixerState(page, SNAPSHOT_B, 'snapshot B store');

  await slotA.locator('.snapshot-recall').click();
  const recalledA = await waitMixerState(page, SNAPSHOT_A, 'snapshot A recall');
  await slotB.locator('.snapshot-recall').click();
  const recalledB = await waitMixerState(page, SNAPSHOT_B, 'snapshot B recall');

  // Recall is one project history action: one header Undo returns B to A.
  await page.waitForFunction(() => !document.querySelector('button.undo-toggle')?.disabled, null, {
    timeout: 10000,
  });
  await page.locator('button.undo-toggle').click();
  const undoneRecall = await waitMixerState(page, SNAPSHOT_A, 'recall Undo');

  // Make a distinct state before opening the overwrite prompt, so cancelling
  // it can be proven by recalling the old A values later.
  await setGain(page, strip, -18);
  await setMute(strip, false);
  const overwritePromptPromise = cancelOverwritePrompt(page);
  await slotA.locator('.snapshot-store').click();
  const overwriteMessage = await overwritePromptPromise;

  await setGain(page, strip, -3);
  await setMute(strip, true);
  await slotA.locator('.snapshot-recall').click();
  const afterCancelledOverwrite = await waitMixerState(
    page,
    SNAPSHOT_A,
    'cancelled overwrite recall',
  );
  if (overwriteMessage.length === 0) fail('overwrite confirmation had no message');
  console.info(
    `mixer snapshots stored A=${JSON.stringify(stateA)} and B=${JSON.stringify(stateB)}, recalled A/B=${JSON.stringify(recalledA)}/${JSON.stringify(recalledB)}, Undo=${JSON.stringify(undoneRecall)}, overwrite Cancel preserved A=${JSON.stringify(afterCancelledOverwrite)}`,
  );
}
