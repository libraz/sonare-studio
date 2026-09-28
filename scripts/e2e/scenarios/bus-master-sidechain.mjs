/** Audible bus/master ducking with a muted pre-fader audio key. */
export const name = 'bus-master-sidechain';

export async function run(ctx) {
  const { page, fail } = ctx;
  const fixture = await page.evaluate(async () => {
    const debug = window.__sonareDebug;
    const pad = debug.addAudioTrack('E2E sidechain pad');
    const key = debug.addAudioTrack('E2E muted key');
    await debug.addToneClip(pad, 4, 220, 0.5, 64);
    await debug.addToneClip(key, 2, 80, 0.9, 64);
    const bus = debug.addMixerBus('E2E keyed bus');
    debug.setTrackOutput(pad, bus);
    const others = debug.trackIds().filter((id) => id !== pad && id !== key);
    for (const id of others) {
      debug.setAutomationLanePoints(id, 'faderDb', [{ ppq: 0, value: -120, curve: 'hold' }]);
    }
    return { pad, key, bus, others };
  });
  const probe = async (includeMasterChain, startPpq, endPpq) =>
    (
      await page.evaluate(
        ({ includeMasterChain, startPpq, endPpq }) =>
          window.__sonareDebug.exportProbe(includeMasterChain, { startPpq, endPpq }),
        { includeMasterChain, startPpq, endPpq },
      )
    ).peakDb;
  const ducking = {
    thresholdDb: -30,
    ratio: 20,
    attackMs: 1,
    releaseMs: 50,
    rangeDb: 24,
  };
  let busInsert = false;
  let masterInsert = false;
  try {
    await page.click('.dock-tabs button:has-text("Mixer")');
    await page
      .locator('.channel-strip')
      .filter({ hasText: 'E2E muted key' })
      .locator('.toggle.mute')
      .click();
    await page.evaluate(
      ({ bus, key, ducking }) => {
        const debug = window.__sonareDebug;
        debug.addBusInsert(bus, 'dynamics.duckingProcessor', ducking);
        debug.setInsertSidechain(`bus:${bus}`, 0, { kind: 'track', trackId: key });
      },
      { ...fixture, ducking },
    );
    busInsert = true;
    const busDucked = await probe(false, 65, 67);
    const busOpen = await probe(false, 69, 71);
    if (!(busOpen - busDucked > 10)) {
      fail(`muted key did not duck bus offline: ${busDucked}/${busOpen} dB`);
    }

    await page.evaluate((bus) => window.__sonareDebug.removeBusInsert(bus, 0), fixture.bus);
    busInsert = false;
    await page.evaluate(
      ({ key, ducking }) => {
        const debug = window.__sonareDebug;
        debug.addMasterInsert('dynamics.duckingProcessor', ducking);
        debug.setInsertSidechain('master', debug.masterInsertCount() - 1, {
          kind: 'track',
          trackId: key,
        });
      },
      { ...fixture, ducking },
    );
    masterInsert = true;
    const masterDucked = await probe(true, 65, 67);
    const masterOpen = await probe(true, 69, 71);
    if (!(masterOpen - masterDucked > 10)) {
      fail(`muted key did not duck master offline: ${masterDucked}/${masterOpen} dB`);
    }
    console.info(
      `PASS bus/master sidechain: bus ${busDucked.toFixed(1)}/${busOpen.toFixed(1)}, ` +
        `master ${masterDucked.toFixed(1)}/${masterOpen.toFixed(1)} dB`,
    );
  } finally {
    await page.evaluate(
      ({ pad, key, bus, others, busInsert, masterInsert }) => {
        const debug = window.__sonareDebug;
        if (!debug) return;
        if (masterInsert && debug.masterInsertCount() > 0)
          debug.removeMasterInsert(debug.masterInsertCount() - 1);
        if (busInsert && debug.projectDocument().mixer.buses.some((entry) => entry.id === bus))
          debug.removeBusInsert(bus, 0);
        for (const id of others) {
          if (debug.trackIds().includes(id)) debug.removeAutomationLane(id, 'faderDb');
        }
        if (debug.trackIds().includes(key)) debug.removeTrack(key);
        if (debug.trackIds().includes(pad)) debug.removeTrack(pad);
        if (debug.projectDocument().mixer.buses.some((entry) => entry.id === bus))
          debug.removeMixerBus(bus);
      },
      { ...fixture, busInsert, masterInsert },
    );
  }
}
