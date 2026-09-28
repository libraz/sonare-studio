/** Audio DI: add an amp, change the rig, bypass it, and compare real WAV output. */
export const name = 'guitar-amp-di';

export async function run(ctx) {
  const { page, fail } = ctx;
  const fixture = await page.evaluate(async () => {
    const debug = window.__sonareDebug;
    const startPpq = 0;
    const trackId = debug.addAudioTrack('Electric Guitar DI E2E');
    const clipId = await debug.addToneClip(trackId, 2, 196, 0.35, startPpq);
    debug.selectClip(clipId);
    return { trackId, startPpq };
  });
  const readExistingMix = () =>
    page.evaluate((excludeTrackId) => {
      const debug = window.__sonareDebug;
      const doc = debug.projectDocument();
      return JSON.stringify({
        tracks: doc.tracks
          .filter((_, index) => debug.trackIds()[index] !== excludeTrackId)
          .map((track) => ({
            id: track.id,
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
    }, fixture.trackId);
  const originalMix = await readExistingMix();
  const probe = () =>
    page.evaluate(
      (startPpq) =>
        window.__sonareDebug.exportProbe(false, {
          startPpq: startPpq + 0.1,
          endPpq: startPpq + 3.8,
        }),
      fixture.startPpq,
    );
  const ampParams = () =>
    page.evaluate((trackId) => {
      const debug = window.__sonareDebug;
      const index = debug.trackIds().indexOf(trackId);
      return debug.projectDocument().tracks[index]?.mixer?.inserts[0]?.params ?? null;
    }, fixture.trackId);
  let openedDevices = false;

  try {
    const dry = await probe();
    console.info(`dry DI probe: ${dry.hash}`);
    if (!(await page.locator('.device-rack').isVisible())) {
      await page.click('.app-bar .devices-toggle');
      openedDevices = true;
    }
    await page.locator('.device-rack .guitar-amp-action').click();
    await page.locator('.device-rack .amp-sim-editor').waitFor({ timeout: 10000 });
    await page.waitForFunction(() => !window.__sonareDebug.applyPending(), null, {
      timeout: 15000,
    });
    const liveError = await page.evaluate(() => window.__sonareDebug.lastError());
    if (liveError) fail(`realtime DI amp sync failed: ${liveError}`);
    const clean = await probe();
    console.info(`clean amp probe: ${clean.hash}`);
    if (!(dry.peakDb > -40 && clean.hash !== dry.hash)) {
      fail(`DI amp did not alter audible export: dry=${dry.hash}, amp=${clean.hash}`);
    }
    const cleanParams = await ampParams();
    if (cleanParams?.presetIndex !== 0) fail(`clean rig not saved: ${JSON.stringify(cleanParams)}`);
    const ampEditor = page.locator('.device-rack .amp-sim-editor');
    const cleanBass = await ampEditor.locator('input[aria-label="Bass"]').inputValue();
    const cleanModel = await ampEditor.locator('.amp-advanced select').first().inputValue();
    if (cleanBass !== '2' || cleanModel !== '1') {
      fail(`Clean Combo controls did not show DSP values: bass=${cleanBass}, model=${cleanModel}`);
    }

    await page.locator('.device-rack .amp-preset').nth(5).click();
    const lead = await probe();
    if (lead.hash === clean.hash) fail('Modern Lead rig sounded identical to Clean Combo');
    const leadParams = await ampParams();
    if (leadParams?.presetIndex !== 5) fail(`lead rig not saved: ${JSON.stringify(leadParams)}`);
    const leadDrive = await ampEditor.locator('input[aria-label="Drive"]').inputValue();
    const leadMiddle = await ampEditor.locator('input[aria-label="Middle"]').inputValue();
    const leadModel = await ampEditor.locator('.amp-advanced select').first().inputValue();
    if (leadDrive !== '0.8' || leadMiddle !== '-3' || leadModel !== '2') {
      fail(
        `Modern Lead controls did not follow its sound: drive=${leadDrive}, middle=${leadMiddle}, model=${leadModel}`,
      );
    }

    await ampEditor.locator('.amp-bypass').click();
    if (
      (await page.locator('.device-rack .insert-power').first().getAttribute('aria-pressed')) !==
      'false'
    ) {
      fail('amp editor bypass did not synchronize the insert row');
    }
    const bypassed = await probe();
    if (bypassed.hash !== dry.hash) {
      fail(`bypassed amp did not restore dry WAV: ${bypassed.hash} vs ${dry.hash}`);
    }
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction(
      (trackId) => {
        const debug = window.__sonareDebug;
        const index = debug.trackIds().indexOf(trackId);
        return debug.projectDocument().tracks[index]?.mixer?.inserts[0]?.params?.presetIndex === 0;
      },
      fixture.trackId,
      { timeout: 10000 },
    );
    const undone = await probe();
    if (undone.hash !== clean.hash) {
      fail(`undo did not restore Clean Combo audio: ${undone.hash} vs ${clean.hash}`);
    }
    // A typical workflow adds the amp before asking for a mix. The assistant
    // must leave that sound-design insert in place and keep it audible.
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
    await dialog.getByRole('button', { name: 'Apply suggestion' }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 10000 });
    const mixedInserts = await page.evaluate((trackId) => {
      const debug = window.__sonareDebug;
      const index = debug.trackIds().indexOf(trackId);
      return (
        debug.projectDocument().tracks[index]?.mixer?.inserts.map((slot) => slot.processor) ?? []
      );
    }, fixture.trackId);
    if (mixedInserts[0] !== 'saturation.ampSim') {
      fail(`mix suggestion removed or reordered the guitar amp: ${mixedInserts.join(',')}`);
    }
    const mixedAmp = await probe();
    await page.locator('.device-rack .insert-power').first().click();
    const mixedBypassed = await probe();
    if (mixedAmp.hash === mixedBypassed.hash)
      fail('preserved amp had no effect after mix suggestion');
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+z');
    const restoredAfterMix = await probe();
    if (restoredAfterMix.hash !== clean.hash) fail('mix suggestion undo did not restore amp scene');

    const driveKnob = page.locator('.device-rack .qc-knob[data-control="drive"]');
    await driveKnob.scrollIntoViewIfNeeded();
    if ((await driveKnob.getAttribute('aria-valuenow')) !== '0.25') {
      fail('amp Quick Control did not inherit the restored Clean Combo drive value');
    }
    await page.locator('.device-rack .strip-auto-t').click();
    const knobBox = await driveKnob.boundingBox();
    if (!knobBox) fail('amp drive Quick Control is not visible');
    else {
      const knobX = knobBox.x + knobBox.width / 2;
      const knobY = knobBox.y + knobBox.height / 2;
      await page.mouse.move(knobX, knobY);
      await page.mouse.down();
      await page.mouse.move(knobX, knobY - 30, { steps: 4 });
      await page.mouse.up();
      const lane = await page.evaluate((trackId) => {
        const debug = window.__sonareDebug;
        const trackIndex = debug.trackIds().indexOf(trackId);
        const track = debug.projectDocument().tracks[trackIndex];
        const id = track?.mixer?.inserts[0]?.id;
        const token = id ? `insert-id:${encodeURIComponent(id)}:drive` : 'insert:0:drive';
        return {
          token,
          points: debug.automationLanePoints(trackId, token),
          mode: debug.stripAutomationMode(trackId),
          lanes: track?.automation,
        };
      }, fixture.trackId);
      if (lane.points.length !== 1) {
        fail(`amp Touch knob did not record one breakpoint: ${JSON.stringify(lane)}`);
      }
      await page.evaluate(
        ({ trackId, token }) => {
          const debug = window.__sonareDebug;
          debug.removeAutomationLane(trackId, token);
          debug.setStripAutomationMode(trackId, 'off');
        },
        { trackId: fixture.trackId, token: lane.token },
      );
    }
    await page.locator('.device-rack .strip-auto-t').click();
    const bassRange = ampEditor.locator('input[aria-label="Bass"]');
    await bassRange.focus();
    await bassRange.press('ArrowRight');
    await bassRange.press('Tab');
    const panelLane = await page.evaluate((trackId) => {
      const debug = window.__sonareDebug;
      const trackIndex = debug.trackIds().indexOf(trackId);
      const id = debug.projectDocument().tracks[trackIndex]?.mixer?.inserts[0]?.id;
      const token = id ? `insert-id:${encodeURIComponent(id)}:bassDb` : 'insert:0:bassDb';
      return { token, points: debug.automationLanePoints(trackId, token) };
    }, fixture.trackId);
    if (panelLane.points.length !== 1 || (await ampParams())?.bassDb !== undefined) {
      fail(
        `amp panel Touch slider wrote a static value instead of a lane: ${JSON.stringify(panelLane)}`,
      );
    }
    await page.evaluate(
      ({ trackId, token }) => {
        const debug = window.__sonareDebug;
        debug.removeAutomationLane(trackId, token);
        debug.setStripAutomationMode(trackId, 'off');
      },
      { trackId: fixture.trackId, token: panelLane.token },
    );
    await page.evaluate((trackId) => {
      window.__sonareDebug.addTrackInsert(trackId, 'saturation.ampSim', { presetIndex: 5 });
    }, fixture.trackId);
    const ampRows = page.locator('.device-rack .insert-row');
    await ampRows.nth(1).locator('.insert-name').click();
    if ((await ampEditor.locator('input[aria-label="Drive"]').inputValue()) !== '0.8') {
      fail('selecting the second amp did not open its Modern Lead controls');
    }
    await ampRows.first().locator('.insert-name').click();
    if ((await ampEditor.locator('input[aria-label="Drive"]').inputValue()) !== '0.25') {
      fail('returning to the first amp did not restore its Clean Combo controls');
    }
    console.info(
      `DI amp changed WAV ${dry.hash} → ${clean.hash} → ${lead.hash}; bypass, mix suggestion, and undo preserved the rig`,
    );
  } finally {
    const dialog = page.getByRole('dialog', { name: 'Suggest a mix' });
    if (await dialog.isVisible().catch(() => false)) await page.keyboard.press('Escape');
    for (let attempt = 0; attempt < 4 && (await readExistingMix()) !== originalMix; attempt++) {
      await page.keyboard.press('ControlOrMeta+z');
    }
    const finalMix = await readExistingMix();
    const existingMixRestored = finalMix === originalMix;
    await page.evaluate((trackId) => {
      const debug = window.__sonareDebug;
      debug.setStripAutomationMode(trackId, 'off');
      if (debug.trackIds().includes(trackId)) debug.removeTrack(trackId);
    }, fixture.trackId);
    if (openedDevices && (await page.locator('.device-rack').isVisible())) {
      await page.click('.app-bar .devices-toggle');
    }
    if (!existingMixRestored) {
      const before = JSON.parse(originalMix);
      const after = JSON.parse(finalMix);
      const changed = after.tracks
        .filter((track, index) => JSON.stringify(track) !== JSON.stringify(before.tracks[index]))
        .map((track) => track.id);
      fail(
        `DI amp E2E left mixer changes: tracks ${changed.join(',')}, master ${JSON.stringify(after.master) !== JSON.stringify(before.master)}, buses ${JSON.stringify(after.buses) !== JSON.stringify(before.buses)}`,
      );
    }
  }
}
