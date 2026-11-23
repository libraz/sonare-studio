/** Export equivalence: automation, sends and buses render. */
export const name = 'export-equivalence';

export async function run(ctx) {
  const { page, fail } = ctx;
  const { rampTrackId } = ctx.state;
  // Read the arrangement box here rather than inheriting one measured in
  // an earlier scenario: the layout moves as scenarios add tracks.
  const rulerBox = await page.locator('.arrangement-canvas').boundingBox();

  // Isolate the steady tone: silence every other track with a held -120 dB
  // fader lane (audible live AND in the export, so the comparison stays
  // apples-to-apples).
  const eqRange = { startPpq: 0, endPpq: 4 };
  const otherIds = await page.evaluate(
    (keep) => window.__sonareDebug.trackIds().filter((id) => id !== keep),
    rampTrackId,
  );
  await page.evaluate((ids) => {
    for (const id of ids) {
      window.__sonareDebug.setAutomationLanePoints(id, 'faderDb', [
        { ppq: 0, value: -120, curve: 'hold' },
      ]);
    }
  }, otherIds);

  const probeBase = await page.evaluate(
    (range) => window.__sonareDebug.exportProbe(true, range),
    eqRange,
  );

  // A constant -24 dB fader lane must shift the exported peak down ~24 dB.
  await page.evaluate(
    (id) =>
      window.__sonareDebug.setAutomationLanePoints(id, 'faderDb', [
        { ppq: 0, value: -24, curve: 'hold' },
      ]),
    rampTrackId,
  );
  const probeAuto = await page.evaluate(
    (range) => window.__sonareDebug.exportProbe(true, range),
    eqRange,
  );
  await page.evaluate(
    (id) => window.__sonareDebug.removeAutomationLane(id, 'faderDb'),
    rampTrackId,
  );
  const autoShift = probeBase.peakDb - probeAuto.peakDb;
  if (!(autoShift > 18 && autoShift < 30)) {
    fail(
      `automation not rendered in export: base ${probeBase.peakDb.toFixed(1)} dB, ` +
        `with -24 dB lane ${probeAuto.peakDb.toFixed(1)} dB`,
    );
  }

  // A unity send into a unity bus must raise the exported level audibly.
  const eqBusId = await page.evaluate((id) => {
    const bus = window.__sonareDebug.addMixerBus('FX');
    window.__sonareDebug.setSend(id, bus, { levelDb: 0, enabled: true });
    return bus;
  }, rampTrackId);
  const probeSend = await page.evaluate(
    (range) => window.__sonareDebug.exportProbe(true, range),
    eqRange,
  );
  const sendLift = probeSend.peakDb - probeBase.peakDb;
  if (!(sendLift > 1.5)) {
    fail(
      `send/bus not rendered in export: base ${probeBase.peakDb.toFixed(1)} dB, ` +
        `with unity send ${probeSend.peakDb.toFixed(1)} dB`,
    );
  }

  // Live playback of the same window with the send active must land in the
  // exported level's ballpark (the meter is a block peak, so allow slack).
  await page.evaluate(() => window.__sonareDebug.setLoopRange(0, 4, true));
  await page.mouse.click(rulerBox.x + 2, rulerBox.y + 14);
  const playStartPpq = await page.evaluate(() => window.__sonareDebug.positionPpq());
  await page.click('.transport-bar .transport-key.play');
  await page.locator('.transport-bar .transport-key.play[aria-pressed="true"]').waitFor();
  await page.waitForFunction((from) => window.__sonareDebug.positionPpq() > from, playStartPpq, {
    timeout: 10000,
  });
  let livePeak = Number.NEGATIVE_INFINITY;
  const liveDeadline = Date.now() + 2400;
  while (Date.now() < liveDeadline) {
    const peak = await page.evaluate(() => window.__sonareDebug.meterPeakDb());
    if (peak !== null && peak > livePeak) livePeak = peak;
    await page.waitForTimeout(100);
  }
  await page.click('.transport-bar .transport-key.stop');
  if (!Number.isFinite(livePeak) || Math.abs(livePeak - probeSend.peakDb) > 6) {
    fail(
      `live vs engine export diverge: live peak ${livePeak.toFixed(1)} dB, ` +
        `export ${probeSend.peakDb.toFixed(1)} dB`,
    );
  } else {
    console.info(
      `PASS export equivalence: automation shift ${autoShift.toFixed(1)} dB, ` +
        `send lift ${sendLift.toFixed(1)} dB, live ${livePeak.toFixed(1)} dB vs ` +
        `export ${probeSend.peakDb.toFixed(1)} dB`,
    );
  }

  // Stems: isolated per-track engine passes. With the send/bus removed and
  // the -120 dB lanes still silencing the other tracks, the tone track's
  // stem must carry the (pre-master) mix level while every other stem stays
  // far below it.
  await page.evaluate(
    ([id, bus]) => {
      window.__sonareDebug.setSend(id, bus, null);
      window.__sonareDebug.removeMixerBus(bus);
    },
    [rampTrackId, eqBusId],
  );
  const allIds = await page.evaluate(() => window.__sonareDebug.trackIds());
  const rampIndex = allIds.indexOf(rampTrackId);
  const probeNoMaster = await page.evaluate(
    (range) => window.__sonareDebug.exportProbe(false, range),
    eqRange,
  );
  const probeStems = await page.evaluate(
    (range) => window.__sonareDebug.exportProbe(false, range, true),
    eqRange,
  );
  const stemList = probeStems.stems ?? [];
  const rampStem = stemList.find((stem) => stem.trackIndex === rampIndex);
  const otherPeaks = stemList
    .filter((stem) => stem.trackIndex !== rampIndex)
    .map((stem) => stem.peakDb);
  const otherMax = otherPeaks.length > 0 ? Math.max(...otherPeaks) : Number.NEGATIVE_INFINITY;
  if (
    stemList.length !== allIds.length ||
    !rampStem ||
    Math.abs(rampStem.peakDb - probeNoMaster.peakDb) > 2 ||
    otherMax > -40
  ) {
    fail(
      `stems not isolated: ${stemList.length}/${allIds.length} stems, tone stem ` +
        `${rampStem ? rampStem.peakDb.toFixed(1) : 'missing'} dB vs mix ` +
        `${probeNoMaster.peakDb.toFixed(1)} dB, max other ${otherMax.toFixed(1)} dB`,
    );
  } else {
    console.info(
      `PASS export stems: ${stemList.length} stems, tone stem ${rampStem.peakDb.toFixed(1)} dB ` +
        `(mix ${probeNoMaster.peakDb.toFixed(1)} dB), max other stem ${otherMax.toFixed(1)} dB`,
    );
  }

  await page.evaluate((others) => {
    for (const other of others) window.__sonareDebug.removeAutomationLane(other, 'faderDb');
    window.__sonareDebug.setLoopRange(0, 4, false);
  }, otherIds);
}
