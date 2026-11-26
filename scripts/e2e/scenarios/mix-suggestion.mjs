/** Measure a real project, apply the mix suggestion, then undo it as one edit. */
import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';

export const name = 'mix-suggestion';

export async function run(ctx) {
  const { context, page } = await openFreshPage(ctx.page);
  try {
    await openEmptyProject(page, ctx.baseUrl);
    await skipTour(page);
    await page.click('.dock-tabs button:has-text("Mixer")');
    await page.click('.transport-bar .transport-key.play');
    await page.waitForFunction(() => window.__sonareDebug.engineStarted(), null, {
      timeout: 15000,
    });
    await page.evaluate(async () => {
      const debug = window.__sonareDebug;
      const first = debug.addAudioTrack('Vocal 1');
      const second = debug.addAudioTrack('Vocal 2');
      await debug.addToneClip(first, 0.75, 440, 0.35, 0);
      await debug.addToneClip(second, 0.75, 660, 0.35, 0);
      const bus = debug.addMixerBus('Assistant fixture bus');
      debug.setTrackOutput(first, bus);
    });
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });
    await page.evaluate(() => window.__sonareDebug.whenEngineSyncIdle());
    const vocal = page
      .locator('.channel-strip')
      .filter({ has: page.locator('.strip-name', { hasText: 'Vocal 1' }) });
    await vocal.locator('.strip-pan .numeric-readout').click();
    const panInput = vocal.locator('input.numeric-readout-input');
    await panInput.fill('-0.75');
    await panInput.press('Enter');
    await panInput.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });
    await page.evaluate(() => window.__sonareDebug.whenEngineSyncIdle());
    await runAssistantScenario({ page, fail: ctx.fail });
  } finally {
    await context.close();
  }
}

async function runAssistantScenario({ page, fail }) {
  const trackId = await page.evaluate(() => window.__sonareDebug.trackIds()[0]);
  const readMix = () =>
    page.evaluate(() => {
      const doc = window.__sonareDebug.projectDocument();
      return JSON.stringify({
        tracks: doc.tracks.map((track) => ({
          mixer: track.mixer ?? null,
          mute: track.mute,
          solo: track.solo,
          pan: track.pan,
          volume: track.volume,
          vcaId: track.vcaId,
        })),
        master: doc.mixer?.master ?? null,
        buses: doc.mixer?.buses ?? [],
        vcaGroups: doc.mixer?.vcaGroups ?? [],
      });
    });
  const original = await readMix();
  let restored = false;

  try {
    // An attenuated fader must not hide the source from dry-stem analysis.
    await page.evaluate((id) => window.__sonareDebug.setStripGainDb(id, -30), trackId);
    const before = await readMix();
    await page.click('.dock-tabs button:has-text("Mixer")');
    await page
      .locator('.mixer-panel .mixer-toolbar .view-menu-wrap')
      .first()
      .locator('button')
      .first()
      .click();
    await page
      .locator('.mixer-panel .scene-menu [role="menuitem"]', { hasText: 'Suggest a mix' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Suggest a mix' });
    await dialog.locator('.suggest-mix-tracks tbody tr').first().waitFor({ timeout: 90000 });
    const rows = await dialog.locator('.suggest-mix-tracks tbody tr').count();
    if (rows === 0) fail('mix assistant did not measure any tracks');
    await page.evaluate(() => window.__sonareDebug.resetApiCalls());
    await dialog.getByRole('button', { name: 'Apply suggestion' }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });
    await page.evaluate(() => window.__sonareDebug.whenEngineSyncIdle());
    const apiRecording = await page.evaluate(() => ({
      enabled: window.__sonareDebug.apiRecordingEnabled,
      calls: window.__sonareDebug.apiCalls(),
    }));
    if (!apiRecording.enabled) {
      fail('API recording is off; this check needs the E2E bundle');
    } else {
      for (const name of [
        'SonareEngine#setStripPan',
        'SonareEngine#setStripInsertBypassed',
        'SonareEngine#setTrackOutputBus',
      ]) {
        if (!apiRecording.calls.includes(name)) {
          fail(`mix suggestion did not reach libsonare ${name}`);
        }
      }
    }

    const after = await readMix();
    if (after === before) fail('mix assistant applied no mixer changes');
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction(
      (previous) => {
        const doc = window.__sonareDebug.projectDocument();
        return (
          JSON.stringify({
            tracks: doc.tracks.map((track) => ({
              mixer: track.mixer ?? null,
              mute: track.mute,
              solo: track.solo,
              pan: track.pan,
              volume: track.volume,
              vcaId: track.vcaId,
            })),
            master: doc.mixer?.master ?? null,
            buses: doc.mixer?.buses ?? [],
            vcaGroups: doc.mixer?.vcaGroups ?? [],
          }) === previous
        );
      },
      before,
      { timeout: 10000 },
    );
    console.info(
      `mix assistant measured ${rows} track(s), changed the scene, and undid in one step`,
    );
  } finally {
    const dialog = page.getByRole('dialog', { name: 'Suggest a mix' });
    if (await dialog.isVisible().catch(() => false)) await page.keyboard.press('Escape');
    // The harness runs later scenarios even after a failure, so restore the
    // mixer edits made by this scenario before handing the shared page back.
    for (let attempt = 0; attempt < 2 && (await readMix()) !== original; attempt++) {
      await page.keyboard.press('ControlOrMeta+z');
    }
    restored = (await readMix()) === original;
  }
  if (!restored) fail('mix suggestion E2E left mixer changes in the shared project');
}
